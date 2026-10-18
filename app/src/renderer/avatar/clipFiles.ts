// The user's gesture clips: Mixamo FBX files retargeted onto the VRM's
// humanoid (the method of three-vrm's Mixamo example: each track's rotation
// moved from Mixamo's rest frame into the normalized bones' world-aligned
// frame, hips height rescaled), or VRMA files through three-vrm-animation.
// Either way the result is an AnimationClip whose tracks target the VRM's
// normalized bone nodes; avatar.ts samples the tracks itself.
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, type VRMAnimation } from "@pixiv/three-vrm-animation";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { AnimationClip, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack, type KeyframeTrack } from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Mixamo rig node -> VRM humanoid bone. */
export const MIXAMO_TO_VRM: Record<string, VRMHumanBoneName> = {
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftHandThumb1: "leftThumbMetacarpal",
  mixamorigLeftHandThumb2: "leftThumbProximal",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandThumb1: "rightThumbMetacarpal",
  mixamorigRightHandThumb2: "rightThumbProximal",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
};

/** A Mixamo FBX ("Without Skin" is enough) as a clip for this VRM. */
export async function loadMixamoClip(url: string, vrm: VRM): Promise<AnimationClip> {
  const asset = await new FBXLoader().loadAsync(url);
  const source = AnimationClip.findByName(asset.animations, "mixamo.com") ?? asset.animations[0];
  if (!source) throw new Error("no animation in the FBX file");
  const tracks: KeyframeTrack[] = [];
  const restInverse = new Quaternion();
  const parentRest = new Quaternion();
  const q = new Quaternion();
  const v = new Vector3();
  const hipsNode = asset.getObjectByName("mixamorigHips");
  const motionHipsHeight = hipsNode ? hipsNode.position.y : 1;
  const vrmHipsY = vrm.humanoid.getNormalizedBoneNode("hips")?.getWorldPosition(v).y ?? 1;
  const vrmRootY = vrm.scene.getWorldPosition(v).y;
  const hipsScale = Math.abs(vrmHipsY - vrmRootY) / (motionHipsHeight || 1);
  const vrm0 = vrm.meta?.metaVersion === "0";
  for (const track of source.tracks) {
    const [rigName, property] = track.name.split(".");
    const bone = MIXAMO_TO_VRM[rigName];
    const node = bone ? vrm.humanoid.getNormalizedBoneNode(bone) : null;
    const rigNode = asset.getObjectByName(rigName);
    if (!node || !rigNode || !rigNode.parent) continue;
    rigNode.getWorldQuaternion(restInverse).invert();
    rigNode.parent.getWorldQuaternion(parentRest);
    if (track instanceof QuaternionKeyframeTrack) {
      const values = Float32Array.from(track.values);
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i).premultiply(parentRest).multiply(restInverse);
        q.toArray(values, i);
      }
      tracks.push(new QuaternionKeyframeTrack(`${node.name}.${property}`, Array.from(track.times), Array.from(values, (x, i) => (vrm0 && i % 2 === 0 ? -x : x))));
    } else if (track instanceof VectorKeyframeTrack && bone === "hips") {
      tracks.push(new VectorKeyframeTrack(`${node.name}.${property}`, Array.from(track.times), Array.from(track.values, (x, i) => (vrm0 && i % 3 !== 1 ? -x : x) * hipsScale)));
    }
  }
  return new AnimationClip("mixamo", source.duration, tracks);
}

/** A VRM Animation (.vrma) as a clip for this VRM. */
export async function loadVrmaClip(url: string, vrm: VRM): Promise<AnimationClip> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const animation = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0];
  if (!animation) throw new Error("no VRM animation in the file");
  return createVRMAnimationClip(animation, vrm);
}

export function loadClip(url: string, vrm: VRM): Promise<AnimationClip> {
  return /\.vrma(\?|$)/i.test(decodeURIComponent(url)) ? loadVrmaClip(url, vrm) : loadMixamoClip(url, vrm);
}
