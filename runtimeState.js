const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function defaultRuntimeStateFile() {
	const directory =
		process.env.RAILWAY_VOLUME_MOUNT_PATH ||
		process.env.DATA_DIR ||
		__dirname;

	return path.join(path.resolve(directory), "runtimeState.json");
}

function createRuntimeState(file = defaultRuntimeStateFile(), io = fs) {
	function read() {
		try {
			if (!io.existsSync(file)) return { desiredRunning: true, initialized: false };
			const parsed = JSON.parse(io.readFileSync(file, "utf8"));
			return { desiredRunning: parsed?.desiredRunning === true, initialized: true };
		} catch (error) {
			console.error("Runtime state read failed:", error.message);
			return { desiredRunning: false, initialized: true };
		}
	}

	function write(desiredRunning) {
		io.mkdirSync(path.dirname(file), { recursive: true });
		const temporary = file + "." + process.pid + "." + randomUUID() + ".tmp";
		try {
			io.writeFileSync(
				temporary,
				JSON.stringify({
					desiredRunning: desiredRunning === true,
					updatedAt: new Date().toISOString()
				}, null, 2),
				{ flag: "wx", flush: true }
			);
			io.renameSync(temporary, file);
		} finally {
			if (io.existsSync(temporary)) io.unlinkSync(temporary);
		}
		return read();
	}

	return {
		read,
		setRunning: () => write(true),
		setStopped: () => write(false),
		file
	};
}

module.exports = { createRuntimeState, defaultRuntimeStateFile };
