# Onboarding 3D assets: sources and licences

All third-party assets here are **CC0 1.0 Universal (public domain dedication)**, which allows
bundling in a commercial app with no attribution required. Credit is given anyway.

| File | Source | Author | Licence |
|---|---|---|---|
| `people-core.glb` (female body, eyes, brows, hairstyles, clips Jog_Fwd_Loop / Walk_Loop / Idle_Loop / Idle_Talking_Loop) | Universal Base Characters [Standard], https://quaternius.itch.io/universal-base-characters (also https://quaternius.com/packs/universalbasecharacters.html); Universal Animation Library [Standard], https://quaternius.itch.io/universal-animation-library | Quaternius | CC0 1.0 (`License_Standard.txt` / `License.txt` in the packs) |
| `people-extra.glb` (male body, eyes, brows, clips Dance_Loop / Jump_Start / Jump_Loop / Jump_Land / Sprint_Loop / Yes / Idle_FoldArms_Loop / Idle_Rail_Call) | Same as above, plus Universal Animation Library 2 [Standard], https://quaternius.itch.io/universal-animation-library-2 | Quaternius | CC0 1.0 |
| `stills/*.webp` | Rendered from this app's own onboarding scene (headless Chrome) | Step2Win | Own work |

The step-counter card draws Lucide's `shield-check` icon path (ISC licence, same as the
`lucide-react` package already used by the app).

## Rebuilding

The GLBs are produced from the downloaded packs by `scripts/build-onboarding-assets.mjs`
(gltf-transform: attribute stripping, hair baked into head-bone space, clips reduced to bone
rotations + pelvis translation and resampled, textures resized to WebP, quantised and
meshopt-compressed). Clothing, skin tones and hair colour are applied at runtime in the shader
(`src/lib/three/onboarding/people.ts`).

```
node scripts/build-onboarding-assets.mjs <dir containing ubc/ ual1/ ual2/>
```
