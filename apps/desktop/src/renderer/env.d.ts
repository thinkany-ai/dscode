import type { DesktopApi } from "../shared/types";

declare global {
  interface Window {
    dscode: DesktopApi;
  }
}

export {};
