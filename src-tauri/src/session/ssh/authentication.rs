use super::*;

/// Most keyboard-interactive rounds one authentication attempt will answer.
/// RFC 4256 puts no limit on them, and a server that keeps asking would
/// otherwise keep the connection — and the user — busy forever.
pub(super) const MAX_AUTH_ROUNDS: usize = 16;

/// How many times the user is asked for a password the profile does not
/// hold, the way OpenSSH's `NumberOfPasswordPrompts` defaults to three.
pub(super) const PASSWORD_ATTEMPTS: usize = 3;

/// Shown above the server's next question when the profile's password was
/// refused, so a password that was rotated elsewhere reads as the cause.
pub(super) const SAVED_PASSWORD_REJECTED: &str = "The saved password was rejected.";

/// Authenticates one hop. The profile's own method goes first; a server that
/// answers it with "not enough, continue with keyboard-interactive" — the
/// shape every SSH MFA deployment takes, whether the second factor is a TOTP
/// code, a push, or a menu — is then followed through `keyboard_interactive`,
/// which asks the user for each round.
///
/// `address` is the `host:port` being authenticated against, which is a jump
/// host for every hop but the last, so the user can see who is asking.
pub(super) async fn authenticate<H: client::Handler>(
    handle: &mut Handle<H>,
    profile: &SessionProfile,
    username: &str,
    address: &str,
    prompter: &AuthPrompter<'_>,
    request: &Request,
) -> Result<()> {
    // Every SSH client opens with the "none" method: it is how the server is
    // asked which methods it will accept, and a server that requires no
    // authentication at all answers it with success instead of a method list.
    // A router whose root password was never set is exactly that case
    // (issue #37) — dropbear lets "none" through for a blank password but
    // refuses the empty password that would be sent below, so a device every
    // other client walks into was the one EdgeTerm could not log in to.
    let AuthResult::Failure {
        remaining_methods: offered,
        ..
    } = handle.authenticate_none(username).await?
    else {
        request.info("auth", format!("{address} requires no authentication"));
        return Ok(());
    };

    let auth = profile.auth.unwrap_or_default();
    let password = profile
        .password
        .clone()
        .filter(|password| !password.is_empty());
    // What the keyboard-interactive rounds may answer a password question
    // with, and the line to show above the first question put to the user.
    let mut saved = None;
    let mut note = "";
    let result = match auth {
        AuthKind::Password => {
            request.info("auth", format!("trying the password method for {username}"));
            let outcome = password_method(
                handle, username, address, prompter, &offered, password, request,
            )
            .await?;
            saved = outcome.saved;
            note = outcome.note;
            outcome.result
        }
        AuthKind::PublicKey => {
            request.info("auth", format!("trying public-key auth for {username}"));
            let path = profile
                .private_key_path
                .clone()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| {
                    AppError::invalid_input("public-key auth needs a private key path")
                })?;
            let path = expand_tilde(&path);
            let passphrase = profile.passphrase.as_deref().filter(|p| !p.is_empty());
            // The path is diagnosis material; its contents and passphrase are
            // never logged.
            request.info("auth", format!("loading the private key from {path}"));
            let key = russh::keys::load_secret_key(&path, passphrase)
                .map_err(|e| AppError::coded(key_code(&e), format!("cannot load {path}: {e}")))?;
            // Modern servers reject SHA-1 RSA signatures; ask the server which
            // hash it accepts before signing.
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
        }
        AuthKind::Agent => {
            request.info("auth", format!("trying the ssh agent for {username}"));
            authenticate_agent(handle, username).await?
        }
    };

    let AuthResult::Failure {
        remaining_methods,
        partial_success,
    } = result
    else {
        return Ok(());
    };

    if remaining_methods.contains(&MethodKind::KeyboardInteractive) {
        // Only a password not yet refused answers the server's password
        // question; see `saved_answer`.
        return keyboard_interactive(handle, username, address, prompter, saved, note, request)
            .await;
    }
    Err(auth_failure(
        auth,
        username,
        partial_success,
        &remaining_methods,
    ))
}

/// Where the `password` method left the login.
pub(super) struct PasswordOutcome {
    pub(super) result: AuthResult,
    /// A password the server has not refused, for a keyboard-interactive
    /// round that asks for it again.
    pub(super) saved: Option<String>,
    /// Shown above the next question the user is asked.
    pub(super) note: &'static str,
}

/// Runs the `password` method for a profile that may or may not hold one
/// (issue #88: a password that rotates centrally is better typed than saved
/// in thirty profiles). A saved password is tried once; a refused one is
/// never sent again, since every refusal counts toward the account's lockout.
/// When the profile holds no password, or its password was refused, a server
/// that also runs keyboard-interactive asks for it there itself; one that
/// runs only `password` would otherwise end the login with nothing asked, so
/// the user is asked here.
pub(super) async fn password_method<H: client::Handler>(
    handle: &mut Handle<H>,
    username: &str,
    address: &str,
    prompter: &AuthPrompter<'_>,
    offered: &MethodSet,
    password: Option<String>,
    request: &Request,
) -> Result<PasswordOutcome> {
    let interactive = |methods: &MethodSet| methods.contains(&MethodKind::KeyboardInteractive);
    if !offered.contains(&MethodKind::Password) {
        // The server checks the password in a keyboard-interactive round, if
        // anywhere; the saved one answers it there.
        return Ok(PasswordOutcome {
            result: AuthResult::Failure {
                remaining_methods: offered.clone(),
                partial_success: false,
            },
            saved: password,
            note: "",
        });
    }

    let mut note = "";
    if let Some(password) = password {
        let result = handle
            .authenticate_password(username, password.clone())
            .await?;
        let AuthResult::Failure {
            remaining_methods,
            partial_success: false,
        } = &result
        else {
            return Ok(PasswordOutcome {
                result,
                saved: Some(password),
                note: "",
            });
        };
        note = SAVED_PASSWORD_REJECTED;
        if interactive(remaining_methods) || !remaining_methods.contains(&MethodKind::Password) {
            return Ok(PasswordOutcome {
                result,
                saved: None,
                note,
            });
        }
    } else if interactive(offered) {
        return Ok(PasswordOutcome {
            result: AuthResult::Failure {
                remaining_methods: offered.clone(),
                partial_success: false,
            },
            saved: None,
            note: "",
        });
    }

    let mut attempt = 0;
    loop {
        attempt += 1;
        let challenge = Challenge {
            address: address.to_string(),
            username: username.to_string(),
            name: "Password Required".to_string(),
            instructions: note.to_string(),
            prompts: vec![AuthPromptField {
                prompt: "Password:".to_string(),
                echo: false,
            }],
        };
        let Some(answers) = prompter.ask(challenge).await? else {
            request.warn(
                "auth",
                format!("the password prompt for {username} was cancelled"),
            );
            return Err(AppError::cancelled(format!(
                "authentication for {username} was cancelled"
            )));
        };
        let password = answers.into_iter().next().unwrap_or_default();
        let result = handle
            .authenticate_password(username, password.clone())
            .await?;
        match &result {
            AuthResult::Failure {
                remaining_methods,
                partial_success: false,
            } => {
                if attempt < PASSWORD_ATTEMPTS && remaining_methods.contains(&MethodKind::Password)
                {
                    note = "Permission denied, please try again.";
                    continue;
                }
                return Ok(PasswordOutcome {
                    result,
                    saved: None,
                    note: "",
                });
            }
            _ => {
                return Ok(PasswordOutcome {
                    result,
                    saved: Some(password),
                    note: "",
                });
            }
        }
    }
}

/// Why authentication stopped, when no method is left that EdgeTerm can run.
pub(super) fn auth_failure(
    auth: AuthKind,
    username: &str,
    partial_success: bool,
    remaining_methods: &MethodSet,
) -> AppError {
    let method = match auth {
        AuthKind::Password => "password",
        AuthKind::PublicKey => "public key",
        AuthKind::Agent => "agent",
    };
    if partial_success {
        // The credential was accepted; the account simply needs another
        // factor, and the server offers no way to supply it here.
        let remaining = remaining_methods
            .iter()
            .map(|method| <&str>::from(method))
            .collect::<Vec<_>>()
            .join(", ");
        return AppError::authentication_denied(format!(
            "the {method} was accepted for {username}, but the server requires another \
             authentication factor and offers only: {remaining}"
        ));
    }
    AppError::authentication_denied(match auth {
        AuthKind::Agent => format!("no identity in the ssh agent was accepted for {username}"),
        _ => format!("authentication failed for {username} ({method})"),
    })
}

/// Runs SSH's `keyboard-interactive` method (RFC 4256) to its end: the server
/// asks questions in rounds, each round is answered, and the server finally
/// accepts or refuses. Providers split a password, a one-time code, a push
/// confirmation and a menu choice over separate rounds, so the loop keeps
/// going until the server stops asking.
pub(super) async fn keyboard_interactive<H: client::Handler>(
    handle: &mut Handle<H>,
    username: &str,
    address: &str,
    prompter: &AuthPrompter<'_>,
    mut saved_password: Option<String>,
    note: &str,
    request: &Request,
) -> Result<()> {
    let mut reply = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await?;
    // A round with nothing to answer only carries text ("a push was sent").
    // Keep it for the next round that does ask, so the user still reads it.
    let mut carried = note.to_string();
    for round in 0..MAX_AUTH_ROUNDS {
        let (name, instructions, prompts) = match reply {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(AppError::authentication_denied(format!(
                    "the server rejected the verification response for {username}"
                )));
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => (name, instructions, prompts),
        };

        let answers = if prompts.is_empty() {
            carried = text_block(&[&carried, &name, &instructions]);
            Vec::new()
        } else if let Some(password) = saved_answer(&prompts, &mut saved_password) {
            vec![password]
        } else {
            let challenge = Challenge {
                address: address.to_string(),
                username: username.to_string(),
                name,
                instructions: text_block(&[&carried, &instructions]),
                prompts: prompts
                    .iter()
                    .map(|prompt| AuthPromptField {
                        prompt: prompt.prompt.clone(),
                        echo: prompt.echo,
                    })
                    .collect(),
            };
            carried.clear();
            // Prompt text is server-supplied and may repeat anything; the log
            // records only how many questions were put to the user.
            request.info(
                "auth",
                format!(
                    "round {}: {address} asked {username} {} question(s)",
                    round + 1,
                    challenge.prompts.len()
                ),
            );
            match prompter.ask(challenge).await? {
                Some(answers) => answers,
                None => {
                    request.warn(
                        "auth",
                        format!(
                            "authentication for {username} was cancelled at round {}",
                            round + 1
                        ),
                    );
                    return Err(AppError::cancelled(format!(
                        "authentication for {username} was cancelled"
                    )));
                }
            }
        };
        reply = handle
            .authenticate_keyboard_interactive_respond(answers)
            .await?;
    }
    Err(AppError::authentication_denied(format!(
        "the server asked {username} for more than {MAX_AUTH_ROUNDS} rounds of verification"
    )))
}

/// The saved password, but only where the server is asking for exactly that:
/// a single hidden answer to a question that names a password. A one-time
/// code, a push confirmation or a menu choice is not in the profile, and the
/// account password must never be sent in answer to one.
pub(super) fn saved_answer(prompts: &[Prompt], saved: &mut Option<String>) -> Option<String> {
    let [only] = prompts else { return None };
    if only.echo || !only.prompt.to_lowercase().contains("password") {
        return None;
    }
    saved.take()
}

/// Joins the parts a server supplies as one block of text, dropping the empty
/// ones — most servers leave both the name and the instructions blank.
pub(super) fn text_block(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Offers the agent's identities in turn. A key the server accepts outright
/// ends the loop, and so does one it accepts pending another factor: that is
/// the identity the session continues with.
pub(super) async fn authenticate_agent<H: client::Handler>(
    handle: &mut Handle<H>,
    username: &str,
) -> Result<AuthResult> {
    let mut agent = connect_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::new(format!("the ssh agent has no usable identities: {e}")))?;
    if identities.is_empty() {
        return Err(AppError::new("the ssh agent holds no identities"));
    }

    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let mut last = AuthResult::Failure {
        remaining_methods: MethodSet::empty(),
        partial_success: false,
    };
    for identity in identities {
        let key = match &identity {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => key.clone(),
            russh::keys::agent::AgentIdentity::Certificate { certificate, .. } => {
                match PublicKey::try_from(certificate.public_key().clone()) {
                    Ok(k) => k,
                    Err(_) => continue,
                }
            }
        };
        let result = handle
            .authenticate_publickey_with(username, key, hash, &mut agent)
            .await
            .map_err(|e| AppError::new(format!("agent authentication failed: {e}")))?;
        match result {
            AuthResult::Success => return Ok(result),
            AuthResult::Failure {
                partial_success: true,
                ..
            } => return Ok(result),
            AuthResult::Failure { .. } => last = result,
        }
    }
    Ok(last)
}

pub(super) type DynamicAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

#[cfg(unix)]
pub(super) async fn connect_agent() -> Result<DynamicAgentClient> {
    AgentClient::connect_env()
        .await
        .map(AgentClient::dynamic)
        .map_err(|e| AppError::new(format!("cannot reach the ssh agent: {e}")))
}

#[cfg(windows)]
pub(super) async fn connect_agent() -> Result<DynamicAgentClient> {
    // Windows OpenSSH exposes its agent through this named pipe. Respect an
    // explicit SSH_AUTH_SOCK first so compatible third-party agents can
    // override it, then fall back to PuTTY's Pageant transport.
    let pipe =
        std::env::var_os("SSH_AUTH_SOCK").unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".into());
    let named_pipe_error = match AgentClient::connect_named_pipe(&pipe).await {
        Ok(agent) => return Ok(agent.dynamic()),
        Err(error) => error,
    };

    match AgentClient::connect_pageant().await {
        Ok(agent) => Ok(agent.dynamic()),
        Err(pageant_error) => Err(AppError::new(format!(
            "cannot reach a Windows SSH agent (OpenSSH: {named_pipe_error}; Pageant: {pageant_error})"
        ))),
    }
}
