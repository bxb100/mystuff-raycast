import { Action, ActionPanel, Form } from "@raycast/api";
import { exec } from "child_process";
import { useEffect, useMemo, useState } from "react";
import useDevices from "./scrcpy/use-devices";
import useScrcpyApps from "./scrcpy/use-scrcpy-apps";
import type { ScrcpyAppOption } from "./scrcpy/types";
import { getScrcpyDir, getScrcpyEnv, shellEscape } from "./scrcpy/utils";
import { showFailureToast } from "@raycast/utils";

type Values = {
  device: string;
  size?: string;
  virtualDisplay: boolean;
  virtualDisplaySize?: string;
  startApp?: string;
  disableAudio: boolean;
  turnScreenOff: boolean;
  stayAwake: boolean;
  hidKeyboard: boolean;
  hidMouse: boolean;
  alwaysOnTop: boolean;
  audioCodec: string;
  moreOptions: string;
};

export default function Command() {
  const [devices, handleDeviceChange] = useDevices();
  const [selectedDevice, setSelectedDevice] = useState<string>();
  const [virtualDisplayEnabled, setVirtualDisplayEnabled] = useState(false);
  const { apps, isLoading: isLoadingApps } = useScrcpyApps(selectedDevice, virtualDisplayEnabled);
  const userApps = useMemo(() => apps.filter((app) => !app.system), [apps]);
  const systemApps = useMemo(() => apps.filter((app) => app.system), [apps]);

  useEffect(() => {
    if (!selectedDevice && devices[0]?.serial) {
      setSelectedDevice(devices[0].serial);
    }
  }, [devices, selectedDevice]);

  function handleSubmit(values: Values) {
    const serial = values["device"];
    void handleDeviceChange({ serial });

    const args = [
      values["turnScreenOff"] ? "--turn-screen-off" : "",
      values["stayAwake"] ? "--stay-awake" : "",
      values["hidKeyboard"] ? "--keyboard=uhid" : "",
      values["hidMouse"] ? "--mouse=uhid" : "",
      values["disableAudio"] ? "--no-audio" : "",
      values["alwaysOnTop"] ? "--always-on-top" : "",
      `--audio-codec=${values["audioCodec"]}`,
      ...buildDisplayArgs(values),
      "-s",
      serial,
    ].filter(Boolean);

    const command = [
      shellEscape(`${getScrcpyDir()}/scrcpy`),
      ...args.map((arg) => shellEscape(arg)),
      values["moreOptions"].trim(),
    ]
      .filter(Boolean)
      .join(" ");

    exec(command, { env: getScrcpyEnv() }, (err) => {
      if (err) {
        void showFailureToast(err, {
          title: "Failed to call scrcpy! Please config it in extension preference",
        });
      }
    });
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={virtualDisplayEnabled ? "Start Virtual Display" : "Mirror"}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="device" title="Device Serial" onChange={setSelectedDevice}>
        {devices.map((device) => {
          if (device.default) {
            return (
              <Form.Dropdown.Section key={device.serial} title="Previous Device">
                <Form.Dropdown.Item value={device.serial} title={device.serial} />
              </Form.Dropdown.Section>
            );
          }
          return <Form.Dropdown.Item key={device.serial} value={device.serial} title={device.serial} />;
        })}
      </Form.Dropdown>

      <Form.Checkbox
        id="virtualDisplay"
        label="Virtual display"
        value={virtualDisplayEnabled}
        onChange={setVirtualDisplayEnabled}
      />

      {virtualDisplayEnabled ? (
        <>
          <Form.TextField
            id="virtualDisplaySize"
            defaultValue=""
            title="Virtual Display Size"
            info="Examples: 1920x1080, 1920x1080/420, /240, or empty to use the main display size and density."
            storeValue
          />
          <Form.Dropdown id="startApp" title="Start App">
            <Form.Dropdown.Item value="" title={isLoadingApps ? "Loading apps..." : "No start app"} />
            {renderAppSection("User Apps", userApps)}
            {renderAppSection("System Apps", systemApps)}
          </Form.Dropdown>
        </>
      ) : (
        <Form.Dropdown id="size" title="Screen Max Size" storeValue>
          <Form.Dropdown.Item value="1024" title="1024" />
          <Form.Dropdown.Item value="0" title="Device size" />
        </Form.Dropdown>
      )}

      <Form.Separator />

      <Form.Description text="Advanced Options" />
      <Form.Checkbox id="disableAudio" defaultValue={true} label="Disable audio" storeValue />
      <Form.Checkbox id="turnScreenOff" defaultValue={true} label="Turn screen off" storeValue />
      <Form.Checkbox id="stayAwake" defaultValue={true} label="Stay awake" storeValue />
      <Form.Checkbox id="hidKeyboard" defaultValue={true} label="HID keyboard" storeValue />
      <Form.Checkbox id="hidMouse" defaultValue={false} label="HID mouse" storeValue />
      <Form.Checkbox id="alwaysOnTop" defaultValue={false} label="Always on top" storeValue />
      <Form.Dropdown id="audioCodec" title="Audio Codec" storeValue>
        <Form.Dropdown.Item value="opus" title="opus" />
        <Form.Dropdown.Item value="aac" title="aac" />
        <Form.Dropdown.Item value="flac" title="flac" />
        <Form.Dropdown.Item value="raw" title="raw" />
      </Form.Dropdown>

      <Form.Separator />

      <Form.TextField
        id="moreOptions"
        defaultValue=""
        title="More options"
        info="For example: `--audio-bit-rate=64K --audio-buffer=40`"
        storeValue
      />
    </Form>
  );
}

function buildDisplayArgs(values: Values): string[] {
  if (!values.virtualDisplay) {
    return ["-m", values.size || "0"];
  }

  const displaySize = values.virtualDisplaySize?.trim();
  const startApp = values.startApp?.trim();

  return [
    displaySize ? `--new-display=${displaySize}` : "--new-display",
    startApp ? `--start-app=${startApp}` : "",
  ].filter(Boolean);
}

function renderAppSection(title: string, apps: ScrcpyAppOption[]) {
  if (apps.length === 0) {
    return null;
  }

  return (
    <Form.Dropdown.Section title={title}>
      {apps.map((app) => (
        <Form.Dropdown.Item
          key={app.packageName}
          value={app.packageName}
          title={`${app.name} [${app.packageName}]${app.disabled ? " (disabled)" : ""}`}
          keywords={[app.packageName]}
        />
      ))}
    </Form.Dropdown.Section>
  );
}
