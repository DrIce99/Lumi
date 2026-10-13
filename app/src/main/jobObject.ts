// A Windows job object with "kill on close": processes assigned to it (the
// sidecar and anything it starts) are terminated by Windows when Lumi
// exits, even if it crashes. Without koffi (or off Windows) it does nothing.
import { log } from "./log";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64. */
const INFO_SIZE = 144;
/** Offset of BasicLimitInformation.LimitFlags. */
const LIMIT_FLAGS_OFFSET = 16;

interface Kernel32 {
  CreateJobObjectW(attributes: null, name: null): unknown;
  SetInformationJobObject(job: unknown, infoClass: number, info: Buffer, size: number): boolean;
  AssignProcessToJobObject(job: unknown, process: unknown): boolean;
  OpenProcess(access: number, inherit: boolean, pid: number): unknown;
  CloseHandle(handle: unknown): boolean;
}

let api: Kernel32 | null | undefined;
let job: unknown = null;

function load(): Kernel32 | null {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== "win32") return api;
  try {
    const koffi = require("koffi") as typeof import("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    api = {
      CreateJobObjectW: kernel32.func("void * __stdcall CreateJobObjectW(void *lpJobAttributes, const char16_t *lpName)"),
      SetInformationJobObject: kernel32.func("bool __stdcall SetInformationJobObject(void *hJob, int JobObjectInformationClass, void *lpJobObjectInformation, uint32_t cbJobObjectInformationLength)"),
      AssignProcessToJobObject: kernel32.func("bool __stdcall AssignProcessToJobObject(void *hJob, void *hProcess)"),
      OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)"),
      CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *hObject)"),
    };
  } catch (err) {
    log.warn("Job objects unavailable: the sidecar may outlive a crash of the app", err);
  }
  return api;
}

/** Puts a process in the kill-on-close job. Returns whether it worked. */
export function bindToLumi(pid: number): boolean {
  const k = load();
  if (!k) return false;
  try {
    if (!job) {
      const handle = k.CreateJobObjectW(null, null);
      if (!handle) return false;
      const info = Buffer.alloc(INFO_SIZE);
      info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
      if (!k.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, INFO_SIZE)) {
        k.CloseHandle(handle);
        return false;
      }
      // The handle stays open for Lumi's whole life: closing it kills the job
      job = handle;
    }
    const process = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (!process) return false;
    const ok = k.AssignProcessToJobObject(job, process);
    k.CloseHandle(process);
    return ok;
  } catch (err) {
    log.warn("Assigning the sidecar to the job object failed", err);
    return false;
  }
}
