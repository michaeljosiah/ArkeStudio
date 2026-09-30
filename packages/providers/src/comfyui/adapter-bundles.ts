import { AdapterBundleSchema, type AdapterBundle } from "@arke-studio/contracts";

// Frozen membership: publisher refreshes must not silently change a saved experiment. Strengths
// are starting values; each member can be tuned inside its own pairing's range.
export const H3_ADAPTER_BUNDLES: readonly AdapterBundle[] = [AdapterBundleSchema.parse({
  // The publisher's own recipe (Hearmeman/minimax-h3-loras README @ de4c3bc6): "Pick one HMNSFW,
  // one HMBreasts and one HMPussy stills file", anatomy underneath and the video-trained action
  // adapter on top. Added after the all-fourteen bundle washed H3 out to a flat field.
  id: "minimax-h3-motion-anatomy-v1", displayName: "Motion + anatomy", recipeId: "comfyui-h3-video",
  status: "experimental", description: "HMPussy and HMBreasts, then HMNSFW-AIO V2.5 on top. Starts at 0.7 each.",
  selections: [
  {
    "releaseId": "hearmeman-hmpussy-v6-epoch30-3080f4fbcbba4fc06bd09240c7eedb6a5128eb0e19feb001cdf97a7a0941a6ee",
    "sha256": "3080f4fbcbba4fc06bd09240c7eedb6a5128eb0e19feb001cdf97a7a0941a6ee",
    "strength": 0.7
  },
  {
    "releaseId": "hearmeman-hmbreastsv2-d260653bdf10775380a44c8f1486bcc4690bd57085cb034002a8fb878f1ad36f",
    "sha256": "d260653bdf10775380a44c8f1486bcc4690bd57085cb034002a8fb878f1ad36f",
    "strength": 0.7
  },
  {
    "releaseId": "hearmeman-hmnsfw-aio-v2.5-a07732a84fd733085eb5d910f602f918fa7a3658117116927e4329f5951a9d2d",
    "sha256": "a07732a84fd733085eb5d910f602f918fa7a3658117116927e4329f5951a9d2d",
    "strength": 0.7
  }
],
}), AdapterBundleSchema.parse({
  id: "minimax-h3-all-adult-v1", displayName: "All MiniMax adult adapters", recipeId: "comfyui-h3-video",
  status: "experimental", description: "All 14 at once. At 1 each the video washes out to flat purple; lower the strengths.",
  selections: [
  {
    "releaseId": "hearmeman-hmbreastsv2-d260653bdf10775380a44c8f1486bcc4690bd57085cb034002a8fb878f1ad36f",
    "sha256": "d260653bdf10775380a44c8f1486bcc4690bd57085cb034002a8fb878f1ad36f",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmbreasts-085e0750-e40-039b6d5399def81c9a459d7cca8ccf749195fcb5f766f0899a387ba2fa6ad967",
    "sha256": "039b6d5399def81c9a459d7cca8ccf749195fcb5f766f0899a387ba2fa6ad967",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmcumshot-v1.0-634c39cfcbfd9421a2d7b5adc62573fc232384c4c75e003c2e11d3408ad0765c",
    "sha256": "634c39cfcbfd9421a2d7b5adc62573fc232384c4c75e003c2e11d3408ad0765c",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmcumshot-v2-1a5b7948bb97f27737e62c3dd5497a3afb77517f230787f45e45c7d8fe3dc24d",
    "sha256": "1a5b7948bb97f27737e62c3dd5497a3afb77517f230787f45e45c7d8fe3dc24d",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hminnie-v1-e50-499196c9d0e5f81ff575ba39a82987112c3bb1e09fbede858877cd950d6c8833",
    "sha256": "499196c9d0e5f81ff575ba39a82987112c3bb1e09fbede858877cd950d6c8833",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmmisdogv2-48e2a82f6bf0049dd42af11085c90bf08c6e2478f22072bebc7666daac2e2113",
    "sha256": "48e2a82f6bf0049dd42af11085c90bf08c6e2478f22072bebc7666daac2e2113",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmnsfw-aio-v2.5-a07732a84fd733085eb5d910f602f918fa7a3658117116927e4329f5951a9d2d",
    "sha256": "a07732a84fd733085eb5d910f602f918fa7a3658117116927e4329f5951a9d2d",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmnsfw-aio-v2-608e4212f2788b6063330ff1196fc1f4b4228cfd9a413a63c198a09d7e4a61cb",
    "sha256": "608e4212f2788b6063330ff1196fc1f4b4228cfd9a413a63c198a09d7e4a61cb",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmpenis-v2-e35-c6c58e9fee848b45e99f97d2520aba4ac63dfc354c07e13c29ac5d8a31a68060",
    "sha256": "c6c58e9fee848b45e99f97d2520aba4ac63dfc354c07e13c29ac5d8a31a68060",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmsquirtv0.1-b25cc54db8e12012e9c1a60c514d767208c855cbf6e81605827d86913249cf24",
    "sha256": "b25cc54db8e12012e9c1a60c514d767208c855cbf6e81605827d86913249cf24",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-vagina-minimax-h3-epoch20-373c3cad3bf27047fdd754fe111443d97e70e3108a8829f2ec63c48832466eb3",
    "sha256": "373c3cad3bf27047fdd754fe111443d97e70e3108a8829f2ec63c48832466eb3",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmmasturbation-v2-f0e4bfbe5baebe972880d2250a227e2f475aa8c18d6d01ed897288d9741659d2",
    "sha256": "f0e4bfbe5baebe972880d2250a227e2f475aa8c18d6d01ed897288d9741659d2",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-hmpussy-v6-epoch30-3080f4fbcbba4fc06bd09240c7eedb6a5128eb0e19feb001cdf97a7a0941a6ee",
    "sha256": "3080f4fbcbba4fc06bd09240c7eedb6a5128eb0e19feb001cdf97a7a0941a6ee",
    "strength": 1
  },
  {
    "releaseId": "hearmeman-vagassist-e40-2c2fdb66bf558de1aabda504a81d4ada5f4cebc20e8f519dc6ed3bb6d4be8c9a",
    "sha256": "2c2fdb66bf558de1aabda504a81d4ada5f4cebc20e8f519dc6ed3bb6d4be8c9a",
    "strength": 1
  }
],
})];
