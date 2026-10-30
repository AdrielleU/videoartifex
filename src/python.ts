import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

export function hasCommand(cmd: string, args: string[]): boolean {
    const r = spawnSync(cmd, args, { stdio: "ignore" });
    return !r.error && r.status === 0;
}

/** How a helper script will run: a python3 that already has `module`, `uv`, or not at all. */
export function pythonFor(module: string): "python3" | "uv" | null {
    if (hasCommand("python3", ["-c", `import ${module.replaceAll("-", "_")}`])) return "python3";
    if (hasCommand("uv", ["--version"])) return "uv";
    return null;
}

/**
 * Runs `scripts/<script>` with a python3 that already has `module` (e.g. the
 * Docker image), otherwise through `uv`, which installs it in an isolated
 * cache on first use.
 */
export async function runPython(module: string, script: string, args: string[], missing: string): Promise<void> {
    const how = pythonFor(module);
    if (!how) throw new Error(missing);
    const file = join(SCRIPTS, script);
    const [cmd, pre] = how === "python3" ? ["python3", [file]] : ["uv", ["run", "--quiet", "--no-project", "--with", module, "python", file]];
    await new Promise<void>((resolve, reject) => {
        const p = spawn(cmd, [...pre, ...args], { stdio: ["ignore", "inherit", "inherit"] });
        p.on("error", reject);
        p.on("close", code => (code === 0 ? resolve() : reject(new Error(`${script} failed (exit ${code})`))));
    });
}
