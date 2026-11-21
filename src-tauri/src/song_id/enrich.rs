use super::SongResult;
use crate::music::{lookup_itunes_tracks, TrackLookupHit};
use std::time::Duration;

fn normalize(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn select_best_hit<'a>(
    hits: &'a [TrackLookupHit],
    song: &SongResult,
) -> Option<&'a TrackLookupHit> {
    let want_title = normalize(&song.title);
    if want_title.is_empty() {
        return None;
    }
    let want_artist = normalize(&song.artist);
    hits.iter().find(|hit| {
        let hit_title = normalize(&hit.title);
        let title_matches = hit_title == want_title
            || hit_title.contains(&want_title)
            || want_title.contains(&hit_title);
        if !title_matches {
            return false;
        }
        if want_artist.is_empty() {
            return true;
        }
        let hit_artist = normalize(&hit.artist);
        hit_artist == want_artist
            || hit_artist.contains(&want_artist)
            || want_artist.contains(&hit_artist)
    })
}

pub async fn fill_artwork(song: &mut SongResult) {
    let query = format!("{} {}", song.artist.trim(), song.title.trim())
        .trim()
        .to_string();
    if query.is_empty() {
        return;
    }
    let Ok(Ok(hits)) =
        tokio::time::timeout(Duration::from_millis(2500), lookup_itunes_tracks(&query, 5)).await
    else {
        return;
    };
    let Some(best) = select_best_hit(&hits, song) else {
        return;
    };
    if !best.artwork.is_empty() {
        song.artwork = best.artwork.clone();
    }
    if song.album.is_empty() {
        if let Some(ref album) = best.album {
            song.album = album.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_best_hit_requires_matching_title_and_artist() {
        let hits = vec![
            TrackLookupHit {
                title: "Unrelated Song".into(),
                artist: "Wrong Artist".into(),
                album: Some("Other".into()),
                artwork: "https://example.test/bad.jpg".into(),
            },
            TrackLookupHit {
                title: "Clair de Lune".into(),
                artist: "Claude Debussy".into(),
                album: Some("Suite bergamasque".into()),
                artwork: "https://example.test/clair.jpg".into(),
            },
        ];
        let song = SongResult {
            title: "Clair de Lune".into(),
            artist: "Debussy".into(),
            album: String::new(),
            artwork: String::new(),
            link: String::new(),
            provider: "ai".into(),
        };
        let best = select_best_hit(&hits, &song).expect("matching hit");
        assert_eq!(best.artwork, "https://example.test/clair.jpg");

        let mismatched = SongResult {
            artist: "Hans Zimmer".into(),
            ..song
        };
        assert!(select_best_hit(&hits, &mismatched).is_none());
    }
}
