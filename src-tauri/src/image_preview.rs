//! Read-only, bounded image previews for the local/SSH Filer. No temporary
//! editable copy, file watcher, or path served through an asset protocol.

use std::io::Read;
use std::path::Path;

use crate::commands::AppState;
use crate::error::{AppError, ErrorCode, Result};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_SIDE: u32 = 16_384;
const MAX_PIXELS: u64 = 32_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
}

fn image_kind(path: &str) -> Result<ImageKind> {
    let extension = Path::new(path)
        .extension()
        .and_then(|part| part.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("png") {
        Ok(ImageKind::Png)
    } else if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
        Ok(ImageKind::Jpeg)
    } else if extension.eq_ignore_ascii_case("gif") {
        Ok(ImageKind::Gif)
    } else if extension.eq_ignore_ascii_case("webp") {
        Ok(ImageKind::Webp)
    } else {
        Err(AppError::invalid_input(
            "only PNG, JPEG, GIF and WebP files can be previewed",
        ))
    }
}

fn u16_be(bytes: &[u8]) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(..2)?.try_into().ok()?))
}

fn u16_le(bytes: &[u8]) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(..2)?.try_into().ok()?))
}

fn u32_be(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?))
}

fn u32_le(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?))
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut pos = 2;
    while pos < bytes.len() {
        if bytes[pos] != 0xff {
            return None;
        }
        while bytes.get(pos) == Some(&0xff) {
            pos += 1;
        }
        let marker = *bytes.get(pos)?;
        pos += 1;
        if marker == 0xda || marker == 0xd9 || marker == 0x00 {
            return None;
        }
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let segment_size = u16_be(bytes.get(pos..)?)? as usize;
        if segment_size < 2 || pos.checked_add(segment_size)? > bytes.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf
        ) {
            if segment_size < 7 {
                return None;
            }
            let height = u16_be(bytes.get(pos + 3..)?)? as u32;
            let width = u16_be(bytes.get(pos + 5..)?)? as u32;
            return Some((width, height));
        }
        pos += segment_size;
    }
    None
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WEBP" {
        return None;
    }
    // RIFF length is all bytes after the first 8. Reject shortened files and
    // trailing unaccounted data instead of asking the renderer to guess.
    if u32_le(bytes.get(4..)?)? as usize + 8 != bytes.len() {
        return None;
    }
    let chunk_type = bytes.get(12..16)?;
    let chunk_size = u32_le(bytes.get(16..)?)? as usize;
    let payload = bytes.get(20..20usize.checked_add(chunk_size)?)?;
    if chunk_type == b"VP8X" && payload.len() >= 10 {
        let width = 1 + u32::from(payload[4]) + (u32::from(payload[5]) << 8)
            + (u32::from(payload[6]) << 16);
        let height = 1 + u32::from(payload[7]) + (u32::from(payload[8]) << 8)
            + (u32::from(payload[9]) << 16);
        Some((width, height))
    } else if chunk_type == b"VP8L" && payload.len() >= 5 && payload[0] == 0x2f {
        let packed = u32_le(payload.get(1..)?)?;
        Some(((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1))
    } else if chunk_type == b"VP8 "
        && payload.len() >= 10
        && payload.get(3..6)? == [0x9d, 0x01, 0x2a]
    {
        let width = (u16_le(payload.get(6..)?)? & 0x3fff) as u32;
        let height = (u16_le(payload.get(8..)?)? & 0x3fff) as u32;
        Some((width, height))
    } else {
        None
    }
}

fn dimensions(bytes: &[u8], kind: ImageKind) -> Option<(u32, u32)> {
    match kind {
        ImageKind::Png
            if bytes.len() >= 33
                && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                && bytes.get(8..12)? == [0, 0, 0, 13]
                && bytes.get(12..16)? == b"IHDR" =>
        {
            Some((u32_be(bytes.get(16..)?)?, u32_be(bytes.get(20..)?)?))
        }
        ImageKind::Jpeg => jpeg_dimensions(bytes),
        ImageKind::Gif
            if bytes.len() >= 13
                && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) =>
        {
            Some((
                u16_le(bytes.get(6..)?)? as u32,
                u16_le(bytes.get(8..)?)? as u32,
            ))
        }
        ImageKind::Webp => webp_dimensions(bytes),
        _ => None,
    }
}

fn validate_image(bytes: &[u8], kind: ImageKind) -> Result<()> {
    let (width, height) = dimensions(bytes, kind).ok_or_else(|| {
        AppError::invalid_input("the file does not contain a supported image header")
    })?;
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(AppError::invalid_input(
            "the image dimensions exceed the safe preview limit; open it externally",
        ));
    }
    Ok(())
}

fn read_local(path: &str) -> Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let before = file.metadata()?;
    if !before.is_file() || before.len() > MAX_BYTES as u64 {
        return Err(AppError::invalid_input(
            "the preview only opens regular images up to 16 MiB",
        ));
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if bytes.len() > MAX_BYTES {
        return Err(AppError::invalid_input("the image exceeds the 16 MiB preview limit"));
    }
    if bytes.len() as u64 != before.len() {
        return Err(AppError::coded(
            ErrorCode::Conflict,
            "the image was truncated while it was being read; retry preview",
        ));
    }
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(AppError::coded(
            ErrorCode::Conflict,
            "the image changed while it was being read; retry preview",
        ));
    }
    Ok(bytes)
}

pub async fn read(state: &AppState, id: Option<String>, path: String) -> Result<Vec<u8>> {
    let kind = image_kind(&path)?;
    let bytes = if let Some(id) = id {
        crate::project::read_preview_bytes(state, &id, &path, MAX_BYTES).await?
    } else {
        tokio::task::spawn_blocking(move || read_local(&path))
            .await
            .map_err(AppError::new)??
    };
    validate_image(&bytes, kind)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_must_match_extension_and_safe_dimensions() {
        let mut png = vec![0u8; 33];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[11] = 13;
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&640u32.to_be_bytes());
        png[20..24].copy_from_slice(&480u32.to_be_bytes());
        assert!(validate_image(&png, ImageKind::Png).is_ok());
        assert!(validate_image(&png, ImageKind::Jpeg).is_err());
        png[16..20].copy_from_slice(&60_000u32.to_be_bytes());
        assert!(validate_image(&png, ImageKind::Png).is_err());
        png[16..20].copy_from_slice(&8_192u32.to_be_bytes());
        png[20..24].copy_from_slice(&8_192u32.to_be_bytes());
        assert!(validate_image(&png, ImageKind::Png).is_err()); // pixel budget
        assert!(validate_image(b"<html><script>hi</script>", ImageKind::Png).is_err());

        let gif = b"GIF89a\x80\x02\xe0\x01\x00\x00\x00";
        assert!(validate_image(gif, ImageKind::Gif).is_ok());

        let jpeg = [0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 1, 224, 2, 128];
        assert!(validate_image(&jpeg, ImageKind::Jpeg).is_ok());
        assert!(image_kind("report.svg").is_err());
        assert!(image_kind("output.HTML").is_err());
        assert_eq!(image_kind("foo.JPEG").unwrap(), ImageKind::Jpeg);
    }

    #[test]
    fn webp_variants_and_bad_riff_sizes() {
        let mut webp = vec![0u8; 30];
        webp[..4].copy_from_slice(b"RIFF");
        webp[4..8].copy_from_slice(&22u32.to_le_bytes());
        webp[8..12].copy_from_slice(b"WEBP");
        webp[12..16].copy_from_slice(b"VP8X");
        webp[16..20].copy_from_slice(&10u32.to_le_bytes());
        webp[24] = 127;
        webp[27] = 63;
        assert!(validate_image(&webp, ImageKind::Webp).is_ok());
        webp[4] = 0;
        assert!(validate_image(&webp, ImageKind::Webp).is_err());
    }
}
