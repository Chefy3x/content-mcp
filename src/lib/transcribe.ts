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

const DEFAULT_MODEL = process.env.MLX_WHISPER_MODEL || "mlx-community/whisper-base-mlx";

// Pulls media via yt-dlp, transcribes with mlx_whisper, returns the transcript.
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

    // mlx_whisper: transcribe to JSON.
    await run(
      "mlx_whisper",
      [
        audioPath,
        "--model", DEFAULT_MODEL,
        "--output-format", "json",
        "--output-dir", workDir,
      ],
      signal,
      workDir
    );

    // mlx_whisper writes <basename>.json in output-dir.
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
      segments: parsed.segments || [],
      model: DEFAULT_MODEL,
      language: parsed.language,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
