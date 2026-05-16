export interface DeviceOption {
  serial: string;
  /**
   * is this the default device?
   */
  default?: boolean;
}

export interface ScrcpyAppOption {
  packageName: string;
  name: string;
  system: boolean;
  disabled: boolean;
}
