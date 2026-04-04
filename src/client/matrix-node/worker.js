let matrixWasmInstance = null;
let matrixWasmLoadPromise = null;

async function loadMatrixWasm() {
	if (matrixWasmInstance) {
		return matrixWasmInstance;
	}
	if (matrixWasmLoadPromise) {
		return matrixWasmLoadPromise;
	}

	matrixWasmLoadPromise = (async () => {
		try {
			const wasmUrl = new URL('../wasm/matrix.wasm', import.meta.url);
			const response = await fetch(wasmUrl);
			if (!response.ok) {
				return null;
			}
			const bytes = await response.arrayBuffer();
			const result = await WebAssembly.instantiate(bytes, {});
			matrixWasmInstance = result.instance;
			return matrixWasmInstance;
		} catch {
			matrixWasmInstance = null;
			return null;
		} finally {
			matrixWasmLoadPromise = null;
		}
	})();

	return matrixWasmLoadPromise;
}

function computeTileJs(payload) {
	const a = payload.matrixA;
	const b = payload.matrixB;
	const rowStart = Number(payload.rowStart);
	const rowEnd = Number(payload.rowEnd);
	const colStart = Number(payload.colStart);
	const colEnd = Number(payload.colEnd);
	const aCols = Number(payload.aCols);

	const tileRows = rowEnd - rowStart;
	const tileCols = colEnd - colStart;
	const tile = Array.from({ length: tileRows }, () => Array.from({ length: tileCols }, () => 0));

	for (let i = rowStart; i < rowEnd; i += 1) {
		for (let j = colStart; j < colEnd; j += 1) {
			let sum = 0;
			for (let k = 0; k < aCols; k += 1) {
				sum += Number(a[i][k]) * Number(b[k][j]);
			}
			tile[i - rowStart][j - colStart] = sum;
		}
	}

	return tile;
}

self.onmessage = async event => {
	const { type, payload } = event.data ?? {};
	if (type !== 'compute-matrix') {
		return;
	}

	try {
		// Load wasm opportunistically so user-provided kernels can be used in future iterations.
		await loadMatrixWasm();
		const tile = computeTileJs(payload);
		self.postMessage({
			type: 'matrix-chunk-computed',
			payload: {
				taskId: payload.taskId,
				chunkId: payload.chunkId,
				tile,
			},
		});
	} catch (error) {
		self.postMessage({
			type: 'worker-error',
			payload: {
				chunkId: payload?.chunkId,
				message: error instanceof Error ? error.message : 'Unknown worker error',
			},
		});
	}
};
