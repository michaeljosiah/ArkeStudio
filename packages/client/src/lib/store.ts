// The client store, split by domain under lib/store/ (issue 2800). This barrel keeps every import
// of lib/store as it was: it re-exports exactly what the single store.ts exported.
export {
  onWorldChange, seedLiveRuns, reconnectNow, devBridge, initStore, send, __setBridgeForTest,
  __clearWorldChatHoldsForTest,
} from "./store/core.js";
export {
  __applyForTest, __handleFrameForTest, __stateForTest, __setStateForTest, __applyEventForTest,
  __mainPhotoAcceptanceForTest, __characterSheetAcceptanceForTest, __pendingQueueRequestsForTest,
  __connectionStatusForTest,
} from "./store/test-hooks.js";
export {
  useStore, useStoreSelector, shallowEqual, useClientState, useWorld, useConnection,
} from "./store/hooks.js";
export type {
  ConnectionStatus, GateNotice, AuthoringActivity, PendingPermission, CanonSearchState,
  CanonRefsState, NarratorQuote, AudiobookAsk, IllustrationRun, HeardLine, SpeakerLinesState,
  StagedTake, WorldOpenProgress, StoreState, WorldChatHold, VoiceCandidatesState,
} from "./store/state.js";
export {
  subscribeDialogueResults, subscribeTransitionProposalResults, subscribePictureProposalResults,
  subscribeEffectProposalResults, subscribeRehearsalResults, subscribePerformanceResults,
  subscribeVoiceSampleResults, generateCharacterVoiceSample, subscribeProjectVoices,
  subscribeDesignedVoices, subscribeDesignedAuditions, subscribeStageConstruction,
  subscribeBriefEnhanced, subscribeCharacterLookImport, subscribeAudiobookExported,
  subscribeCreatorPublishing, creatorPublishing, subscribeArkePlayerExported,
  subscribeStoryExportState, subscribeAudiobookTallProgress, lastAudiobookTallProgress,
  subscribeAudiobookVideoExported, subscribeAudiobookMotion, subscribeAudiobookWords,
  requestAudiobookWords, subscribeAudiobookWordTiming, subscribeAudiobookVideoState,
  subscribeGuideVoiceLines, subscribeGuideDrafting, guideDraftingOf, subscribeWebPackages,
  subscribeStoryPublications, publishStory, listStoryPublications, subscribeAudiobookListening,
  subscribeAudioStudio, subscribeAudiobookMix, subscribeAudiobookTimingProposal,
  subscribeBenchSubjectOpened, subscribeBenchReferenceUsed, subscribeBenchSubjectAccepted,
  subscribeBenchTakeFiles, subscribeBenchTakeDeleted, subscribeLookRename, renameSavedLook,
  subscribeReferenceImages, browseReferenceImages, subscribeWorldArtifacts, browseWorldArtifacts,
  borrowArtifacts, borrowTakes, subscribeWorldChatMediaOpened, subscribeConversationActionDecision,
  subscribeLyricsDrafted, subscribeMusicLyricsDrafted, subscribeMusicHeardIn,
  subscribeMusicRendered, subscribeMusicTakes, subscribeMusicWaveform, subscribeFiledBatch,
  subscribeAudiobookActivity, subscribeQueueResults, subscribeVoiceAssignmentResults,
  subscribeVoiceUploadConfirmations, subscribeVoiceDeleteResults, subscribeWorldImport, importWorld,
  subscribeCommandFailures, subscribeSceneRefusals, subscribeTimelineRefusals,
  subscribeWorldChatCreateResults, subscribeNarrativeSaved, subscribeProductionSetupResults,
  subscribeProductionCreateResults, subscribeChapterCreateResults, subscribeChapterOpenResults,
  subscribeDramaHeard, subscribeDramaSound, subscribeComicScriptSaveResults, subscribeComicPages,
  subscribeComicExported, subscribeEpisodeScriptSaveResults, subscribeDramaEditions,
  publishDramaEdition, listDramaEditions, readDramaSource, subscribeChapterSaveResults,
  subscribeSceneCreateResults, subscribeSheetEditResults, subscribeSingleActResults,
  subscribeProposalResolutions, gateAnswered, forgetGateRequest, subscribeCanonContradictions,
  subscribeFrameRunQuote, clearFrameRunQuote, subscribeFrameRunStartResult,
  clearFrameRunStartResult, subscribeRoutingFindings, subscribeInteractiveExports,
  subscribePlanResults, subscribePlanStates, subscribeJobReady, subscribeRecoveryNotices,
  onStudioAssistantReply, subscribeRemoteRefusals, requestMediaMeasurement, setPromptTools,
  requestPromptTools,
} from "./store/events.js";
export {
  subscribeManuscriptReview, requestManuscriptReview, subscribeChapterReview, requestChapterReview,
  requestChapterReviewPreflight, decideChapterReview,
} from "./store/manuscript.js";
export {
  subscribeWorldChatInputResults, sendWorldChatInput, worldChatInputStatus, removeWorldChatInput,
  continueWorldChatInputs, subscribeWorldChatSendResults, worldChatSendResult,
} from "./store/world-chat.js";
export type {
  QueueEnqueueResult, VoiceAssignmentResult, DialogueResult, RehearsalResult, PerformanceResult,
  VoiceSampleResult, VoiceUploadConfirmationRequired, FiledBatch, BriefEnhanced, AudiobookExported,
  CharacterLookImported, CreatorPublishingChanged, ArkePlayerExported, StoryExportStateAnswer,
  AudiobookTallProgress, AudiobookVideoExported, AudiobookVideoStateAnswer, AudiobookMotionAnswer,
  AudiobookWordTimingAnswer, AudiobookWordsAnswer, GuideVoiceLines, GuideDrafting,
  WebPackagesListed, StoryPublishAnswer, AudiobookListeningAnswer, AudiobookMixAnswer,
  AudioStudioAnswer, AudiobookTimingProposalAnswer, BenchSubjectOpened, BenchSubjectAccepted,
  BenchTakeFiles, BenchTakeDeleted, ReferenceImagesResult, LookRenameResult, WorldArtifactsResult,
  WorldChatMediaOpened, ConversationActionDecisionResult, LyricsDrafted, MusicLyricsDrafted,
  MusicHeardIn, MusicRendered, MusicTakes, MusicWaveformAnswer, VoiceDeleteResult,
  ProductionCreateResult, TimelineCommandRefusal, ProductionSetupResult, WorldChatCreateResult,
  ChapterCreateResult, ChapterOpenResult, ChapterVersionResult, DramaHeard, DramaSound,
  ComicScriptSaveResult, ComicPageQuote, ComicPageMade, ComicTakeResult, ComicPageLettered,
  ComicLetteringPlaced, ComicExported, EpisodeScriptSaveResult, ChapterSaveResult,
  SceneCreateResult, SheetEditResult, SingleActResult, CanonContradictions, PlanResult,
  PlanStateEvent, FrameRunQuoteEvent, FrameRunStartResultEvent, RoutingFindingsEvent,
  InteractiveExportEvent,
} from "./store/events.js";
export type { ChapterReviewUpdate, ManuscriptReviewUpdate } from "./store/manuscript.js";
export type { WorldChatSendResult, WorldChatInputResult } from "./store/world-chat.js";
export {
  openWorld, createWorld, attachFiles, hostCanAttach, canAttachConversationFiles, attachHostFiles,
  attachHostText, genesisAttachFiles, generateWorldImage, uploadWorldImage, keepWorldImage,
  discardWorldImage, generateMasterLook, uploadMasterLook, pickStagedReference,
  clearStagedReference, keepMasterLook, discardMasterLook, archiveWorld, useArchiveNote,
  installSampleWorld, cancelSampleWorldDownload, discardSampleWorldDownload,
  refreshSampleWorldDownload, useSampleWorld, reconcileExternalEdit,
} from "./store/world.js";
export {
  stageSheetEdit, restoreSheetVersion, stageArtDirectionChange, setArtDirection, acceptProposal,
  discardProposal, rebaseProposal, resolveProposalConflict, markProposalSeen, resolveProposalChoice,
  updateProposalPassage, useGateNotices,
} from "./store/gate.js";
export {
  draftWithStudio, continueStudio, useTranscripts, setupSkip, setupRetry, setupRepair, setupPause,
  setupResume, setupCancel, useSetup, useDiagnostics, refreshProductionSpend, refreshDiagnostics,
  refreshSystemResources, genesisChat, takeRejectedGenesisChat, listGenesisDrafts, loadGenesisDraft,
  reviewGenesisDraft, reviewGenesisImages, reviewGenesisVoices, reviewGenesisReadiness,
  leaveGenesisFinding, generateGenesisVoice, decideGenesisVoice, reviewGenesisImports,
  resolveGenesisImport, generateGenesisImage, decideGenesisImage, proposeGenesisWorld,
  decideGenesisDraft, genesisDiscard, planFoundingBuild, beginFoundingBuild, stopFoundingBuild,
  runBuildItem, dismissBuildNotice, generateLookPreview, planKeyArt, useKeyArtPlans, useBuildPlans,
  useGenesis, cancelAuthoring, replyToPermission, useAuthoring, usePermissions,
} from "./store/authoring.js";
export {
  askCanon, searchCanonList, requestCanonRefs, stageCanonEntry, stageCanonAmendment, openThread,
  settleThread, requestCanonContradictions, undoSingleAct, renameWorld, retireEntity, useAskResults,
  useCanonSearches, useCanonRefs, createSheetFromSentence, promoteGuest, duplicateSheet,
  setSheetStatus, renameSheet, setSheetNarration, assignVoice, providerIdOf, requestSheetRefs,
  useSheetRefs,
} from "./store/canon.js";
export type { SheetRefsState } from "./store/canon.js";
export {
  setCredential, clearCredential, validateProvider, signInProviderTool, cancelProviderToolSignIn,
  refreshProviderTool, selectProviderWorkspace, refreshVendorAuth, beginVendorSignIn,
  submitVendorSignInCode, submitVendorKey, cancelVendorSignIn, signInAccount, createAccount,
  cancelAccountSignIn, signOutAccount, openAccountPage, removeVendorConnection, setAgentConfig,
  listHarnessModels, setRoutingDefault, setProductionModel, setWorldModel, setResearchWeb,
  setImageInspection, setWorldImageInspection, setLocalSampling, adapterCommand, setModelEnabled,
  setSpendThreshold, detectRuntimes, checkOnboarding, saveOnboarding, detectHarnesses,
  setHarnessEngine, chooseClaudeExecutable, clearClaudeExecutable, chooseCodexExecutable,
  clearCodexExecutable, setSpeechBackend, chooseVoxaExecutable, clearVoxaExecutable, useBundledVoxa, restartVoxa,
  repairVoiceModels,
} from "./store/providers.js";
export {
  chooseComfyUiPath, chooseComfyUiModelsDir, clearComfyUiModelsDir, setComfyUiUrl,
  clearComfyUiEngine, setOllamaUrl, useManagedOllama, refreshOllama, updateOllamaRuntime,
  useDetectedComfyUi, refreshComfyUi, setupInstall, setupRemove, restartComfyUi,
  verifyComfyUiRecipe, openModelFolder, testLocalVoice, setBackgroundNotifications, markInboxSeen,
  settleFileProblems, markWhatsNewSeen, cancelJob, retryJobFinalization, deleteJob, resolveHeldJob,
  resumeQueue, useReconcileReport, openEngineLog, updateComfyUiRuntime,
} from "./store/engines.js";
export {
  chooseAnchor, useMainPhotoAcceptance, clearMainPhotoAcceptance, importMainPhotoCandidate,
  importMainPhoto, importCharacterSheet, useCharacterSheetAcceptance, clearCharacterSheetAcceptance,
  generateMainPhoto, generateCharacterSheet, acceptCharacterSheet, generateLocationView,
  acceptLocationView, importLocationViewCandidate, useLocationViewUpload, clearLocationViewUpload,
  generateCharacterLooks, acceptCharacterLook, makeChapterLook, acceptChapterLook,
  readAudiobookLooks, chooseAudiobookLook, rejectReferenceTake, promoteCharacterLook,
  attachCharacterLook, setStyleOverride, createProp, addPropState, importPropStateCandidate,
  acceptPropState,
} from "./store/references.js";
export {
  setNarrator, setProviderPlan, requestVoiceCatalogue, requestCataloguePreview,
  stopCataloguePreview, designVoice, saveVoiceDesign, listProjectVoices, hearDesignedVoice,
  requestVoiceLine, requestVoiceCandidates, requestVoicePreview, readSheetSection, readSheetPage,
  readBibleSection, readProse, readProsePage, transcribeDictation, stageVoiceClip, discardVoiceClip,
  cloneVoice, deleteVoice, useVoiceClips, useVoiceCloned, useVoiceCandidates, useVoicePreviews,
  useVoiceAudio, useVoiceParts, useDictation, generatePerformance,
} from "./store/voice.js";
export type { ReadingVoice, StagedClip } from "./store/voice.js";
export {
  createProduction, proposeStoryOverview, draftStoryOverview, proposeSeason, createEpisode,
  proposeEpisode, reorderEpisodes, createScene, isOwnSceneCreate, sceneCommand, frameRunCommand,
  restoreScene, deleteScene, saveBible, setGuideEntry, setGuideTeasers, setGuideStory,
  draftGuideDescription, stopGuideDrafting, listGuideVoiceLines, restoreBible, createChapter,
  isOwnChapterCreate, stopProsePage, openChapter, saveChapter, saveEpisodeScript, hearDramaLines,
  generateDramaSound, setDramaRole, setDramaVerdict, decideDramaNote, decideDramaTake,
  readChapterVersion, restoreChapter, setChapterRetired, editChapterPlan, reorderChapters,
  reorderScenes, setProductionAspect, dispatchScenePlanned, planContinue, planReconfirm, planCancel,
  listPlans, planTableRead, prepareTableRead, saveRouting, sendRoutingCommand, recordTraversal,
  listRoutingFindings, proposeBranchCanon, exportInteractive, compileSceneBoard, exportSceneBoard,
} from "./store/productions.js";
export {
  saveComicScript, quoteComicPage, makeComicPanels, setComicLettering, placeComicLettering,
  finishComicPage, makeComicPage, exportComic, checkComicTake, acceptComicTake, stopComicMake,
  seeComicWarning, setComicSettings,
} from "./store/comics.js";
export {
  addMusicTrack, updateMusicTrack, removeMusicTrack, reorderMusicTracks, setMusicCover,
  draftMusicLyrics, readMusicHeardIn, renderMusic, makeMusicTakes, chooseMusicTake, editMusicTrack,
  setMusicSequence, readMusicTakes, readMusicWaveform,
} from "./store/music.js";
export {
  sendEffectProposalCommand, acceptTake, beginStageExport, writeStageExportFrame, cancelStageExport,
  stagePlayblast, failStagePlayblastAction, importShotFrame, clearShotFrame, setShotTrim,
  moveTimelinePictureClip, sendTimelineCommands, moveTimelineHistory, uploadArtifacts,
  restoreArtifact, retireArtifact, importEditorMedia, rejectTake, exportCut, sendTimelineTranscribe,
  sendTimelineAssemble, cancelExport, exportWorld, useExports, fileArtifactMsg, deriveContinuity,
  stopContinuity, useDeriving, castVoices, setVoicePin, stopVoices,
} from "./store/takes.js";
export type { ExportState } from "./store/takes.js";
export {
  readAudiobookChapter, stopAudiobook, setAudiobookReading, setAudiobookRequests,
  keepAudiobookSplit, setAudiobookNote, setAudiobookNarrator, setAudiobookChapterNarrator,
  quoteAudiobookNarrator, hearAudiobookLine, HEAR_ANSWER_MS, HEAR_NO_ANSWER, useNarratorQuotes,
  useHeardLines, setAudiobookRecorded, dismissAudiobookRun, useAudiobookRuns, readAudiobookBlocks,
  stageAudiobookTake, keepAudiobookTake, previewAudiobookScript, exportAudiobookScript,
  stageAudiobookLines, keepAudiobookLines, discardAudiobookLines, useSpeakerLines,
  discardAudiobookTake, useStagedTakes, setAudiobookBlock, setAudiobookSeam, resetAudiobookSeams,
  groupChapterBeats, openAudiobookListening, setAudiobookPicture, deriveAudiobookLook,
  linkAudiobookCharacter, setAudiobookLook, setAudiobookTiming, readAudioStudio, recordAudioHeard,
  readAudioHeard, subscribeAudioHeard, editAudioStudio, decideAudioStudioProposal,
  readAudioStudioSource, previewAudioStudio, stopAudioStudioPreview, setAudiobookReaction,
  setAudiobookBed, setAudiobookSound, proposeAudiobookTiming, acceptAudiobookTiming,
  renderAudiobookMix, directChapter, previewDirection, setAudiobookReadingNote,
  draftAudiobookSpeakerNotes, suggestAudiobookPicture, makeAudiobookPicture,
  rewriteAudiobookPicturePrompt, setAudiobookPictureShapes, makeAudiobookTallPicture,
  makeAudiobookTallPictures, stopAudiobookTallPictures, useAudiobookAsks, illustrateChapter,
  skipIllustrationRow, sendIllustrationWithout, refreshIllustrationReferences, acceptIllustration,
  stopIllustration, dismissIllustration, useIllustrationRuns, acceptDirection, dismissDirection,
  useDirectionRuns, useBeatRuns, useAudiobookRecords,
} from "./store/audiobook.js";
export {
  openAudiobook, readAudiobookBook, stopAudiobookBook, dismissAudiobookBook, dismissAudiobookNote,
  useAudiobookDoors, useAudiobookCredits, openAudiobookCredits, setAudiobookCredits,
  useAudiobookBooks, useAudiobookNotes,
} from "./store/audiobook-door.js";
export {
  exportManuscript, openExportsFolder, exportAudiobookVideo, readAudiobookVideo,
  moveAudiobookPicture, setAudiobookPictureFocus, exportAudiobookPlayer, exportAudiobookChapters,
  readStoryExport, exportArkePlayer, listWebPackages, pickManuscript, importManuscript,
  rereadManuscript, cancelManuscript, useManuscripts, useCasting, extractArtifact, stopExtraction,
  useReading, resolveExtraction, useImportReport, useArtifactNotices,
} from "./store/manuscript.js";
export type { ImportReportState } from "./store/manuscript.js";
export {
  checkUpdates, downloadUpdate, installUpdateAndRestart, installUpdateOnClose, acknowledgeUpdate,
  generateDiagnostics, setRecoveryMode, setRecoveryAdvanced, reviewRecoveryAction,
  setRecoveryPreferences, controlRecoveryHistory, readRecoveryHistory, listProviderCalls,
  useProviderCalls, openDataFolder, useEnvCheck, useUpdateStatus, useDiagnosticsBundle,
  recordReview, useVoiceSidecar, useVoiceRuntimeTest,
} from "./store/updates.js";
export type { StoreEnvCheck } from "./store/updates.js";
export {
  openWorldChat, createWorldChat, sendWorldChat, askWorldChatSendStatus, worldChatHold,
  prepareConversationTakeReview, decideConversationAction, conversationGroupApprovalPort,
  decideEditorRequest, cancelWorldChat, retryWorldChatTurn, saveWorldChatPoint,
  rejectWorldChatPoint, openWorldChatMedia, wrapUpWorldChat, deleteWorldChat, worldChatAttachFiles,
  promoteWorldChatAttachment, worldChatAttachTarget, useWorldChatRefusals,
  useWorldChatWrapUpRefusal, useWorldChatRipples, dismissWorldChatRipples, useWorldChatProgress,
  setWorldChatInitiative, archiveWorldChat, unarchiveWorldChat, sendProposalBack,
} from "./store/world-chat.js";
export {
  useBench, sendBenchOpen, sendBenchOpenSubject, sendBenchRebuildSubject, sendBenchNewSession,
  sendBenchClose, sendBenchTitle, sendBenchCompose, sendBenchAddReference, sendBenchEnhanceBrief,
  sendBenchDraftLyrics, sendBenchPresetSave, sendBenchPresetDelete, sendBenchRemoveReference,
  sendBenchUploadReferences, sendBenchDispatch, sendBenchRerun, sendBenchUpscale, sendBenchKeep,
  sendBenchUseReference, sendBenchAccept, sendBenchDiscard, sendBenchTakeFiles, sendBenchDelete,
  sendBenchClearView, sendBenchSelectTake, sendStageArtifactReference, sendAttachFilesCorrelated,
} from "./store/bench.js";

export { onVoiceConversationReply } from "./store/events.js";
