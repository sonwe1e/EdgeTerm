use super::*;

/// Key exchange methods, strongest first: russh's default list with the NIST
/// ECDH curves where OpenSSH's default list has them. russh leaves them out,
/// and plenty of network gear offers nothing newer — the H3C switch in issue
/// #60 lists `ecdh-sha2-nistp256` first.
pub(super) const KEX_ORDER: &[kex::Name] = &[
    kex::MLKEM768X25519_SHA256,
    kex::CURVE25519,
    kex::CURVE25519_PRE_RFC_8731,
    kex::ECDH_SHA2_NISTP256,
    kex::ECDH_SHA2_NISTP384,
    kex::ECDH_SHA2_NISTP521,
    kex::DH_GEX_SHA256,
    kex::DH_G18_SHA512,
    kex::DH_G17_SHA512,
    kex::DH_G16_SHA512,
    kex::DH_G15_SHA512,
    kex::DH_G14_SHA256,
];

/// What a server offering nothing better is still connected with (issue
/// #60): switches, routers and firewalls keep SSH stacks that stop at SHA-1
/// key exchange hashes, CBC ciphers and SHA-1 MACs, and the terminal clients
/// network engineers use still talk to them. They come after every modern
/// choice and the client's order decides, so a server that supports anything
/// better gets that. Nobody in the middle can strip the better choices to
/// force these either: both sides' lists are part of the exchange hash the
/// host key signs. A connection that does end up on one is listed in
/// `SessionInfo::legacy_algorithms`, which the status bar shows.
///
/// group14-sha1 comes before group-exchange-sha1 because the size of an
/// exchanged group is only known once the method is settled: a device whose
/// moduli are smaller than `GEX_MIN_GROUP_BITS` fails the connection there,
/// with no way back to the fixed 2048-bit group it also offers.
pub(super) const LEGACY_KEX: &[kex::Name] = &[kex::DH_G14_SHA1, kex::DH_GEX_SHA1, kex::DH_G1_SHA1];

/// Markers that ride in the key exchange list without being methods: RFC 8308
/// extension negotiation and OpenSSH's strict key exchange (the Terrapin fix).
pub(super) const KEX_EXTENSIONS: &[kex::Name] = &[
    kex::EXTENSION_SUPPORT_AS_CLIENT,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
];

/// russh's default ciphers plus aes128-gcm, which OpenSSH offers too.
pub(super) const CIPHER_ORDER: &[cipher::Name] = &[
    cipher::CHACHA20_POLY1305,
    cipher::AES_256_GCM,
    cipher::AES_128_GCM,
    cipher::AES_256_CTR,
    cipher::AES_192_CTR,
    cipher::AES_128_CTR,
];

/// See `LEGACY_KEX`. 3des-cbc would need russh's `des` feature.
pub(super) const LEGACY_CIPHERS: &[cipher::Name] = &[
    cipher::AES_256_CBC,
    cipher::AES_192_CBC,
    cipher::AES_128_CBC,
];

/// Ciphers that authenticate what they encrypt. russh still settles a MAC
/// next to one when the lists allow, but never uses it.
pub(super) const AEAD_CIPHERS: &[cipher::Name] = &[
    cipher::CHACHA20_POLY1305,
    cipher::AES_256_GCM,
    cipher::AES_128_GCM,
];

pub(super) const MAC_ORDER: &[mac::Name] = &[
    mac::HMAC_SHA512_ETM,
    mac::HMAC_SHA256_ETM,
    mac::HMAC_SHA512,
    mac::HMAC_SHA256,
];

/// See `LEGACY_KEX`.
pub(super) const LEGACY_MACS: &[mac::Name] = &[mac::HMAC_SHA1_ETM, mac::HMAC_SHA1];

/// Smallest group a group exchange may hand the client. russh asks for 3072
/// bits by default, more than an old device's moduli reach; 2048 is OpenSSH's
/// floor, and the lowest russh accepts.
pub(super) const GEX_MIN_GROUP_BITS: usize = 2048;

/// The transport settings every hop, jump host or target, connects with.
pub(super) fn client_config() -> client::Config {
    let gex = GexParams::default();
    client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        // Match the bounded transfer pipeline on high-latency links.
        window_size: 8 * 1024 * 1024,
        preferred: Preferred {
            kex: Cow::Owned([KEX_ORDER, LEGACY_KEX, KEX_EXTENSIONS].concat()),
            cipher: Cow::Owned([CIPHER_ORDER, LEGACY_CIPHERS].concat()),
            mac: Cow::Owned([MAC_ORDER, LEGACY_MACS].concat()),
            // Host keys: russh's list already ends in `ssh-rsa`.
            ..Preferred::DEFAULT
        },
        gex: GexParams::new(
            GEX_MIN_GROUP_BITS,
            gex.preferred_group_size(),
            gex.max_group_size(),
        )
        .expect("russh's own group sizes stay above the lowered floor"),
        ..Default::default()
    }
}

/// The legacy algorithms (see `LEGACY_KEX`) among those a key exchange
/// settled on, by name.
pub(super) fn legacy_choices(
    kex: &kex::Name,
    key: &Algorithm,
    cipher: &cipher::Name,
    macs: [&mac::Name; 2],
) -> Vec<String> {
    let mut legacy = Vec::new();
    if LEGACY_KEX.contains(kex) {
        legacy.push(kex.as_ref().to_string());
    }
    // An RSA host key signing with SHA-1. russh offers it for the same
    // servers the lists above are for; OpenSSH stopped accepting it in 8.8.
    if *key == (Algorithm::Rsa { hash: None }) {
        legacy.push(key.as_str().to_string());
    }
    if LEGACY_CIPHERS.contains(cipher) {
        legacy.push(cipher.as_ref().to_string());
    }
    if !AEAD_CIPHERS.contains(cipher) {
        for mac in macs {
            let name = mac.as_ref().to_string();
            if LEGACY_MACS.contains(mac) && !legacy.contains(&name) {
                legacy.push(name);
            }
        }
    }
    legacy
}

/// Where a transport's handler leaves the legacy algorithms its latest key
/// exchange settled on, for `connect_hop` to read once the handshake is done.
#[derive(Clone, Default)]
pub(super) struct LegacyRecord(pub(super) Arc<Mutex<Vec<String>>>);

impl LegacyRecord {
    pub(super) fn record(&self, names: &Names) {
        *self.0.lock() = legacy_choices(
            &names.kex,
            &names.key,
            &names.cipher,
            [&names.client_mac, &names.server_mac],
        );
    }

    pub(super) fn get(&self) -> Vec<String> {
        self.0.lock().clone()
    }
}

/// russh's report of a failed negotiation lists our algorithms before the
/// server's: a wall of names in which the part the user needs, what the
/// server offers, comes last.
pub(super) fn handshake_failure(e: &russh::Error) -> String {
    let russh::Error::NoCommonAlgo { kind, theirs, .. } = e else {
        return e.to_string();
    };
    let what = match kind {
        AlgorithmKind::Kex => "key exchange method",
        AlgorithmKind::Key => "host key algorithm",
        AlgorithmKind::Cipher => "cipher",
        AlgorithmKind::Mac => "MAC",
        AlgorithmKind::Compression => "compression method",
    };
    let offered: Vec<&str> = theirs
        .iter()
        .map(String::as_str)
        // The server's key exchange list carries the markers too.
        .filter(|name| !name.starts_with("ext-info-") && !name.starts_with("kex-strict-"))
        .collect();
    format!(
        "no {what} in common with the server, which offers only: {}",
        offered.join(", ")
    )
}
