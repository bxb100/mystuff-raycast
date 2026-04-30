import { useExec } from "@raycast/utils";
import { useEffect, useMemo } from "react";
import { HeadsetControlOutput } from "../types";
import { brewPath } from "../utils";

const DEFAULT_REFRESH_INTERVAL = 3_000;

export function useHeadsetControl(refreshInterval = DEFAULT_REFRESH_INTERVAL) {
  const { isLoading, data, error, revalidate } = useExec(brewPath, ["-o", "json"], {
    keepPreviousData: true,
  });
  const headsetControlOutput = useMemo<HeadsetControlOutput>(() => JSON.parse(data || "{}") || [], [data]);

  useEffect(() => {
    if (refreshInterval <= 0 || error) {
      return;
    }

    const timer = setInterval(() => {
      revalidate();
    }, refreshInterval);

    return () => {
      clearInterval(timer);
    };
  }, [refreshInterval, revalidate, error]);

  return {
    isLoading,
    revalidate,
    devices: headsetControlOutput.devices || [],
  };
}
