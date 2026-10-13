/**
 * Template plugin — copy this directory under `extensions/` to start a new plugin.
 *
 * A plugin is a directory with an `index.ts` that default-exports a factory.
 * Pi calls the factory once per runtime load; register everything from there.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { greeting } from "./greeting.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("hello", {
		description: "Say hello (template plugin)",
		handler: async (name, ctx) => {
			ctx.ui.notify(greeting(name?.trim() || "world"), "info");
		},
	});
}
