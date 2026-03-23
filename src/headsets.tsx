import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useHeadsetControl } from "./headsets/hook/useHeadsetControl";
import { getBatteryIcon, getBrandIcon, playNotification, sidetoneSet, toggleLights } from "./headsets/utils";

export default function Command() {
  const { isLoading, revalidate, devices } = useHeadsetControl();

  return (
    <List isLoading={isLoading && devices.length === 0}>
      {devices.map((device) => (
        <List.Item
          icon={getBrandIcon(device)}
          key={device.id_vendor}
          title={device.device}
          subtitle={device.product}
          accessories={[
            {
              icon: getBatteryIcon(device),
              tooltip: `Battery: ${device.battery.level}%, Status: ${device.battery.status}`,
            },
            {
              text: device.battery.time_to_empty_min ? `Empy after ${device.battery.time_to_empty_min} min` : null,
            },
          ]}
          actions={
            <ActionPanel>
              <Action title={"Refresh"} icon={Icon.ArrowClockwise} onAction={revalidate} />
              {device.capabilities.includes("CAP_NOTIFICATION_SOUND") ? (
                <Action title={"Play Notification Sound"} icon={Icon.Bell} onAction={() => playNotification(device)} />
              ) : null}
              {device.capabilities.includes("CAP_LIGHTS") ? (
                <>
                  <Action title={"Disable Lights"} icon={Icon.LightBulbOff} onAction={() => toggleLights(device, 0)} />
                  <Action title={"Enable Lights"} icon={Icon.LightBulb} onAction={() => toggleLights(device, 1)} />
                </>
              ) : null}
              {device.capabilities.includes("CAP_SIDETONE") ? (
                <>
                  <Action title={"Sidetone Max"} icon={Icon.Microphone} onAction={() => sidetoneSet(device, 128)} />
                  <Action
                    title={"Sidetone Disable"}
                    icon={Icon.MicrophoneDisabled}
                    onAction={() => sidetoneSet(device, 0)}
                  />
                </>
              ) : null}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
