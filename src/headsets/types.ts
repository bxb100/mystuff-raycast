export interface HeadsetControlOutput {
  name: string;
  version: string;
  api_version: string;
  hidapi_version: string;
  device_count: number;
  devices: Device[];
}

export interface Device {
  status: string;
  device: string;
  vendor: string;
  product: string;
  id_vendor: string;
  id_product: string;
  capabilities: string[];
  capabilities_str: string[];
  battery: Battery;
}

export interface Battery {
  status: string;
  level: number;
  time_to_empty_min: number;
}
