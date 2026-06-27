import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerProtonBridgeExtension from "./protonmail.ts";

export default function registerProtonMailExtension(pi: ExtensionAPI) {
	return registerProtonBridgeExtension(pi);
}
