import { showToast, Toast } from "@raycast/api";
import { exec } from "child_process";
import { useEffect, useState } from "react";
import type { ScrcpyAppOption } from "./types";
import { getScrcpyDir, getScrcpyEnv, shellEscape } from "./utils";

type ScrcpyAppsState = {
  apps: ScrcpyAppOption[];
  isLoading: boolean;
};

export default function useScrcpyApps(deviceSerial: string | undefined, enabled: boolean): ScrcpyAppsState {
  const [apps, setApps] = useState<ScrcpyAppOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !deviceSerial) {
      setApps([]);
      setIsLoading(false);
      return;
    }

    let isCanceled = false;
    setIsLoading(true);

    const command = [shellEscape(`${getScrcpyDir()}/scrcpy`), "--list-apps", "-s", shellEscape(deviceSerial)].join(" ");

    const child = exec(command, { env: getScrcpyEnv() }, (err, stdout, stderr) => {
      if (isCanceled) {
        return;
      }

      setIsLoading(false);

      if (err) {
        setApps([]);
        void showToast({
          style: Toast.Style.Failure,
          title: "Failed to fetch Android apps",
          message: err.message,
        });
        return;
      }

      setApps(parseScrcpyApps(`${stdout}\n${stderr}`));
    });

    return () => {
      isCanceled = true;
      child.kill();
    };
  }, [deviceSerial, enabled]);

  return { apps, isLoading };
}

function parseScrcpyApps(output: string): ScrcpyAppOption[] {
  const lines = output.split(/\r?\n/).map((line) => line.replace(/^\s*INFO:\s*/, ""));

  const appLines = lines.reduce<string[]>((result, line) => {
    if (/^\s+\[[^\]]+\]/.test(line) && result.length > 0) {
      result[result.length - 1] = `${result[result.length - 1]} ${line.trim()}`;
      return result;
    }

    result.push(line);
    return result;
  }, []);

  return appLines.flatMap((line) => {
    // oxlint-disable-next-line no-useless-escape
    const match = line.match(/^\s*([*-])\s+(.+)\s+([\w\.]+)$/);
    if (!match) {
      return [];
    }

    return [
      {
        packageName: match[3].trim(),
        name: match[2].trim(),
        system: match[1] === "*",
        disabled: line.includes("(disabled)"),
      },
    ];
  });
}
