/// <reference path="./types.d.ts" />

import deepSeek from "./src/language/deepSeek";
import atlasCloudText from "./src/language/atlasCloud";
import easyRouterText from "./src/language/easyRouter";
import openRouter from "./src/language/openRouter";
import tokenHub from "./src/language/tokenHub";
import token01 from "./src/language/token01";
import apiMart from "./src/media/apiMart";
import meta from "./src/media/meta";
import agnes from "./src/media/agnes";
import volcengine from "./src/media/volcengine";
import volcSpeech from "./src/media/volcSpeech";
import bailian from "./src/media/bailian";
import kling from "./src/media/kling";
import vidu from "./src/media/vidu";
import atlasCloud from "./src/media/atlasCloud";
import easyRouter from "./src/media/easyRouter";
import qwenSpeech from "./src/media/qwenSpeech";
import museTalk from "./src/media/museTalk";
import gen3c from "./src/media/gen3c";
import tencentWand from "./src/media/tencentWand";

export type Provider = ProviderDefinition;
export type CameraTrajectory = CameraTrajectorySpec;
export type ProviderTools = ProviderContext["tool"];
export type ProviderTask = MediaTask;
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [deepSeek, atlasCloudText, easyRouterText, openRouter, tokenHub, token01] as const;
export const mediaProviders = [apiMart, meta, agnes, volcengine, volcSpeech, bailian, kling, vidu, atlasCloud, easyRouter, qwenSpeech, museTalk, gen3c, tencentWand] as const;
