// Entry of the avatar bundle (dist/renderer/avatar/index.js): three.js and
// the VRM loader are big, so the face window loads them only in 3D mode.
import { Avatar, type AvatarModule } from "./avatar";

declare global {
  interface Window {
    LumiAvatar?: AvatarModule;
  }
}

window.LumiAvatar = { Avatar };
