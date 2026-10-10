import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TranscribeResult {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  model: string;
  language?: string;
}

function run(
  cmd: string,
  args: string[],
  signal: AbortSignal,
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort);
    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

// Two Whisper backends behind one call. MLX is Apple Silicon only, so anywhere
// else (a Linux server) runs whisper-ctranslate2, the CPU build of
// faster-whisper, which takes the same audio and writes the same JSON.
// WHISPER_BACKEND=mlx|ctranslate2 overrides the per-platform default.
type Backend = "mlx" | "ctranslate2";
const BACKEND: Backend =
  process.env.WHISPER_BACKEND === "mlx" || process.env.WHISPER_BACKEND === "ctranslate2"
    ? process.env.WHISPER_BACKEND
    : process.platform === "darwin"
      ? "mlx"
      : "ctranslate2";
const MLX_MODEL = process.env.MLX_WHISPER_MODEL || "mlx-community/whisper-base-mlx";
const CT2_MODEL = process.env.WHISPER_MODEL || "small";

async function whisper(audioPath: string, workDir: string, signal: AbortSignal): Promise<string> {
  if (BACKEND === "mlx") {
    await run(
      "mlx_whisper",
      [audioPath, "--model", MLX_MODEL, "--output-format", "json", "--output-dir", workDir],
      signal,
      workDir
    );
    return MLX_MODEL;
  }
  await run(
    "whisper-ctranslate2",
    [
      audioPath,
      "--model", CT2_MODEL,
      // int8 is the CPU setting: about a tenth of real time on two cores.
      "--compute_type", "int8",
      "--output_format", "json",
      "--output_dir", workDir,
      "--verbose", "False",
    ],
    signal,
    workDir
  );
  return CT2_MODEL;
}

// Pulls media via yt-dlp, transcribes with Whisper, returns the transcript.
// Cleans up its temp dir on success or failure.
export async function transcribeFromUrl(
  url: string,
  signal: AbortSignal
): Promise<TranscribeResult> {
  const workDir = await mkdtemp(join(tmpdir(), "content-mcp-"));
  try {
    // yt-dlp: pull best audio, extract to mp3.
    await run(
      "yt-dlp",
      [
        "-f", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "mp3",
        "--no-playlist",
        "-o", join(workDir, "audio.%(ext)s"),
        url,
      ],
      signal,
      workDir
    );

    // Find the extracted audio file.
    const files = await readdir(workDir);
    const audio = files.find((f) => f.startsWith("audio."));
    if (!audio) throw new Error("yt-dlp did not produce an audio file");
    const audioPath = join(workDir, audio);

    const model = await whisper(audioPath, workDir, signal);

    // Both backends write <basename>.json in the output dir.
    const base = audio.replace(/\.[^.]+$/, "");
    const jsonPath = join(workDir, `${base}.json`);
    const raw = await readFile(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
      language?: string;
    };

    return {
      text: (parsed.text || "").trim(),
      segments: (parsed.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
      model,
      language: parsed.language,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface VideoInfo {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  repost_count?: number;
  timestamp?: number;
  webpage_url?: string;
}

// What yt-dlp knows about a post without downloading it: who, when, the
// caption and the counts. Throws when the post has no video or needs a login.
export async function videoInfo(url: string, signal: AbortSignal): Promise<VideoInfo> {
  const { stdout } = await run(
    "yt-dlp",
    ["--dump-single-json", "--no-playlist", "--skip-download", "--no-warnings", url],
    signal
  );
  return JSON.parse(stdout) as VideoInfo;
}
