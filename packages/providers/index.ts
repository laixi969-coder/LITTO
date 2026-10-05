/// <reference path="./types.d.ts" />

import deepSeek from "./src/language/deepSeek";
import atlasCloudText from "./src/language/atlasCloud";
import easyRouterText from "./src/language/easyRouter";
import apiMart from "./src/media/apiMart";
import meta from "./src/media/meta";
import agnes from "./src/media/agnes";
import volcengine from "./src/media/volcengine";
import bailian from "./src/media/bailian";
import kling from "./src/media/kling";
import atlasCloud from "./src/media/atlasCloud";
import easyRouter from "./src/media/easyRouter";

export type Provider = ProviderDefinition;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

// LITTO does not offer the Toonflow TF-Router relay (its adapters stay in src/ but are not listed or auto-installed).
export const languageProviders = [deepSeek, atlasCloudText, easyRouterText] as const;
export const mediaProviders = [apiMart, meta, agnes, volcengine, bailian, kling, atlasCloud, easyRouter] as const;
