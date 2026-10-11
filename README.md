# content-mcp

MCP server that takes a URL from any supported source and saves a normalized markdown + JSON pair to a local directory. Same verb (`get_content`) whether you're saving a YouTube transcript, a tweet, an arxiv paper, or a blog post.

## Sources

| Source | URLs it matches | What it saves |
|---|---|---|
| `youtube` | `youtube.com/*`, `youtu.be/*` | Captions + video metadata. Optional ad-chapter stripping. |
| `x` | `x.com/*/status/*`, `twitter.com/*/status/*` | Tweet body + thread-parent walk + quoted tweet. Optional local Whisper transcription of attached video. |
| `instagram` | `instagram.com/p/*`, `/reel/*`, `/reels/*`, `/tv/*` | Caption, author, counts + a Whisper transcript of the video. A photo post saves its caption only. |
| `tiktok` | `tiktok.com/@*/video/*`, `vm.tiktok.com/*`, `tiktok.com/t/*` | Caption, author, counts + a Whisper transcript of the video. |
| `paper` | `arxiv.org/abs/*`, `arxiv.org/pdf/*` | Title, authors, abstract, categories, DOI. |
| `article` | any other `http(s)://` URL | Catch-all Readability extraction (title + body). |

Source is inferred from the URL — no source param on the tools.

## Install / run

```bash
git clone https://github.com/Chefy3x/content-mcp.git
cd content-mcp
npm install
npm run build
```

Register with Claude Code (user scope so it works everywhere). Run this from inside the `content-mcp` folder so `$(pwd)` resolves to the right path:

```bash
claude mcp add content-mcp --scope user -- node "$(pwd)/dist/index.js"
```

Or skip the commands: paste this repo's URL into Claude Code and tell it "install this MCP for me."

## Environment

| Var | Default | Purpose |
|---|---|---|
| `CONTENT_DIR` | `~/Documents/Content` | Where saved content lives. Sharded by source. |
| `MLX_WHISPER_MODEL` | `mlx-community/whisper-base-mlx` | MLX Whisper model for video transcription on a Mac. Upgrade to `whisper-small-mlx` or `whisper-large-v3-mlx` for better accuracy. |
| `WHISPER_BACKEND` | `mlx` on macOS, `ctranslate2` elsewhere | Which Whisper runs. `ctranslate2` is [whisper-ctranslate2](https://github.com/Softcatala/whisper-ctranslate2), the CPU build that works on a Linux server. |
| `WHISPER_MODEL` | `small` | Model for the `ctranslate2` backend. |

Video transcription (X video, Instagram, TikTok) needs `yt-dlp` and `ffmpeg` on the PATH, plus `mlx_whisper` on a Mac or `whisper-ctranslate2` on Linux.

## Storage layout

```
~/Documents/Content/
  youtube/youtube_<id>.content.{md,json}
  x/x_<id>.content.{md,json}
  paper/paper_<id>.content.{md,json}
  article/article_<hash>.content.{md,json}
```

Pictures and video are saved beside the text, one folder per item:

```
~/Documents/Content/
  x/media/x_<id>/image_1.jpg, video.mp4, frame_1.jpg …
  instagram/media/instagram_<id>/video.mp4, frame_1.jpg …, cover.jpg
  tiktok/media/tiktok_<id>/video.mp4, frame_1.jpg …, cover.jpg
  youtube/media/youtube_<id>/thumbnail.jpg
  article/media/article_<hash>/image_1.png …
```

| Source | What is saved |
|---|---|
| `x` | Every image on the post and its quoted post; the video (mp4, up to 1080p) with four stills. A saved video with sound is transcribed. |
| `instagram`, `tiktok` | The clip, four stills from it and its cover image. A photo post saves its first picture; the rest of a carousel needs a login. |
| `youtube` | The thumbnail. The video only with `downloadVideo: true`. |
| `article` | The lead image and up to eight figures from the body. |

The saved paths are listed under `## Media` in the item's markdown and in `source_specific.media_files`. Pass `downloadMedia: false` for text only. A video over 400 MB is skipped (`CONTENT_MAX_VIDEO_MB` changes the limit). Media needs `yt-dlp` and `ffmpeg` on the PATH.

**Media is deleted after 7 days.** Pictures and video are working material and clips add up, so each item's media folder is removed 7 days after it was saved; the item's text and metadata stay. The clean-up runs when the server starts. Set `CONTENT_MEDIA_DAYS` to change the number of days, or to `0` to keep media forever. Fetching the link again with `refresh: true` downloads it again.

Each `.content.md` has YAML frontmatter (`source`, `id`, `url`, `title`, `fetched_at`, `content_hash`) + a human-readable body. Each `.content.json` has the full `meta` plus extractor-specific `raw` (YouTube transcript entries, X thread chain, etc.).

## Tools

**Universal**

- `get_content(url, refresh?, stripAds?, transcribeVideo?, downloadMedia?, downloadVideo?)` — fetch, normalize, save. Returns metadata only (not the body). `refresh: true` forces a re-fetch.
- `batch_content(urls, refresh?, stripAds?, transcribeVideo?)` — same, across many URLs. Sequential to avoid rate-limit bursts.
- `get_metadata(url)` — return stored metadata for a URL, or live-fetch metadata only (no body save) if nothing is cached.
- `list_content(source?)` — list saved items, optionally scoped to one source.
- `search_content(query, limit?, source?, id?)` — keyword search, ranked (TF + coverage + title bonus). Scope to one source or one saved item.
- `delete_content(source, id)` — remove both the md and json for a saved item.

**YouTube-only**

- `youtube_get_chapters(url)` — chapter markers (timestamp + title).
- `youtube_get_transcript_segment(url, startTime, endTime)` — transcript text for a time window. Uses cached entries when available.
- `youtube_get_channel_videos(url, limit?)` — list recent videos for a channel.
- `youtube_get_playlist_videos(url, limit?)` — list all videos in a playlist.
- `youtube_summarize_transcript(url)` — structural sections/WPM overview. Not an LLM summary.

## Source-specific options on `get_content`

- `stripAds: true` (YouTube) — drops transcript entries inside chapters titled sponsor/ad/promo. Ignored on non-YouTube URLs.
- `transcribeVideo: true` (X) — if the tweet has attached video, pulls it with `yt-dlp`, transcribes locally with MLX Whisper, and folds the transcript into the saved content. Slow (seconds to minutes depending on clip length); first call also downloads the model weights (~140MB for `base`). Ignored on non-X URLs.

## System dependencies

- `node` ≥ 20
- `yt-dlp` (X video) — `brew install yt-dlp`
- `ffmpeg` (X video) — `brew install ffmpeg`
- `mlx_whisper` (X video) — `uv tool install mlx-whisper`

Text extractors (YouTube captions, X text, arxiv, articles) have no external deps beyond npm packages.

## Known limitations

- X text: syndication endpoint returns the target tweet + parent chain only. Downstream replies by other users aren't captured.
- Paper: arxiv only. DOI / non-arxiv papers (OpenAlex, direct DOIs) not implemented. Full PDF parsing deferred.
- Article: Readability's `textContent` drops inline images and link markup in favor of clean prose.
- No per-ID flock or per-source rate limiter yet. Fine for one-at-a-time use; concurrent bursts across sessions could thrash.

## License

MIT. See [LICENSE](LICENSE).
