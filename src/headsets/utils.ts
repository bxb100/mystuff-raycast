import { Color, Icon, Image, showToast, Toast } from "@raycast/api";
import { cpus } from "os";
import { exec } from "node:child_process";
import { Device } from "./types";
import Style = Toast.Style;
import ImageLike = Image.ImageLike;

export const brewPath = cpus()[0].model.includes("Apple")
  ? "/opt/homebrew/bin/headsetcontrol"
  : "/usr/local/bin/headsetcontrol";

export function getBatteryIcon(device: Device): { source: Icon; tintColor: Color } {
  const level = device.battery.level;
  const tintColor = level > 20 ? Color.Green : level > 10 ? Color.Orange : Color.Red;

  const source = device.battery.status === "BATTERY_CHARGING" ? Icon.BatteryCharging : Icon.Battery;
  return { source, tintColor };
}

export function getBrandIcon(device: Device): ImageLike | undefined {
  const vendor = device.vendor.toLowerCase();
  const brands = ["corsair", "logitech", "steelseries", "hyperx", "lenovo"];
  for (const brand of brands) {
    if (vendor.includes(brand)) {
      return {
        source: `headset/${brand}.svg`,
      };
    }
  }
  return {
    source: Icon.Headphones,
  };
}

export function toggleLights(device: Device, status: 0 | 1) {
  exec(`${brewPath} -d ${device.id_vendor}:${device.id_product} -l ${status}`, async (error, stdout, stderr) => {
    if (error) {
      await showToast(Style.Failure, "Failed to toggle lights", error.message);
      return;
    }
    await showToast(Style.Success, `Lights ${status === 1 ? "enabled" : "disabled"}`, stdout || stderr);
  });
}

export function playNotification(device: Device) {
  const random = Math.random() > 0.5 ? 0 : 1;
  exec(`${brewPath} -d ${device.id_vendor}:${device.id_product} -n  ${random}`);
}

export function sidetoneSet(device: Device, volume: number) {
  const v = Math.max(0, Math.min(128, volume));
  exec(`${brewPath} -d ${device.id_vendor}:${device.id_product} -s ${v}`);
}
