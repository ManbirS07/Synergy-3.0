import { DbConnection } from '/module_bindings/index.js';

const SPACETIMEDB_URI = window.GRIDFORGOOD_URI ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = window.GRIDFORGOOD_DB_NAME ?? 'hack';
const DONATED_KEY = 'gridforgood_matrix_donated_chunks';
const MATRIX_TASK_KEY = 'matrix_mul';

const toggleButton = document.getElementById('toggle-compute');
const donatedChunksEl = document.getElementById('donated-chunks');
const tilesSolvedEl = document.getElementById('tiles-solved');
const nodeIdEl = document.getElementById('node-id');
const statusEl = document.getElementById('status');

const worker = new Worker(new URL('./worker.js', import.meta.url), {
	type: 'module',
});

let enabled = false;
let conn = null;
let myIdentityHex = '';
let matrixTaskId = null;
let solvedTiles = 0;
const activeChunkIds = new Set();
let cachedJobVersion = '';
let cachedMatrixA = null;
let cachedMatrixB = null;

function unwrapOption(value) {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value === 'object' && 'tag' in value) {
		if (value.tag === 'some' || value.tag === 'Some') {
			return value.value;
		}
		return undefined;
	}

	if (typeof value === 'object' && 'some' in value) {
		return value.some;
	}

	return value;
}

function setStatus(message) {
	statusEl.textContent = message;
}

function getDonatedCount() {
	const value = Number.parseInt(localStorage.getItem(DONATED_KEY) ?? '0', 10);
	return Number.isNaN(value) ? 0 : value;
}

function setDonatedCount(next) {
	localStorage.setItem(DONATED_KEY, `${next}`);
	donatedChunksEl.textContent = `${next}`;
}

function setSolvedTiles(next) {
	solvedTiles = Math.max(0, Number(next) || 0);
	tilesSolvedEl.textContent = `${solvedTiles}`;
}

function clearMatrixCache() {
	cachedJobVersion = '';
	cachedMatrixA = null;
	cachedMatrixB = null;
}

function getMatricesForJob(job) {
	const updatedAt = job?.updatedAtMicros?.toString?.() ?? `${job?.updatedAtMicros ?? ''}`;
	const nextVersion = `${updatedAt}:${job?.status ?? ''}`;
	if (cachedJobVersion === nextVersion && cachedMatrixA && cachedMatrixB) {
		return { matrixA: cachedMatrixA, matrixB: cachedMatrixB };
	}

	try {
		cachedMatrixA = JSON.parse(job.matrixAJson);
		cachedMatrixB = JSON.parse(job.matrixBJson);
		cachedJobVersion = nextVersion;
		return { matrixA: cachedMatrixA, matrixB: cachedMatrixB };
	} catch {
		clearMatrixCache();
		return null;
	}
}

function resolveMatrixTaskId() {
	if (!conn) {
		matrixTaskId = null;
		return;
	}
	for (const task of conn.db.task.iter()) {
		if (task.taskKey === MATRIX_TASK_KEY) {
			matrixTaskId = Number(task.taskId);
			return;
		}
	}
	matrixTaskId = null;
}

function getCurrentJob() {
	if (!conn) {
		return null;
	}
	return conn.db.matrixJobConfig.id.find(1) ?? null;
}

function maybeClaimMatrixWork() {
	if (!enabled || !conn || !matrixTaskId) {
		return;
	}

	const job = getCurrentJob();
	if (!job || job.status !== 'running') {
		setStatus('Waiting for a matrix job to be submitted.');
		return;
	}

	try {
		conn.reducers.requestWork({ taskId: matrixTaskId });
	} catch (error) {
		console.error('request_work failed:', error);
	}
}

function processMatrixChunkIfMine(row) {
	if (!enabled || !conn || !matrixTaskId || Number(row.taskId) !== Number(matrixTaskId)) {
		return;
	}

	const assignedNode = unwrapOption(row.assignedNode);
	if (!assignedNode) {
		return;
	}
	if (assignedNode.toHexString() !== myIdentityHex || row.status !== 'processing') {
		return;
	}

	const chunkId = row.chunkId.toString();
	if (activeChunkIds.has(chunkId)) {
		return;
	}

	const job = getCurrentJob();
	if (!job) {
		clearMatrixCache();
		setStatus('No matrix job config found.');
		return;
	}

	const matrices = getMatricesForJob(job);
	if (!matrices) {
		setStatus('Invalid matrix job payload.');
		return;
	}

	activeChunkIds.add(chunkId);
	setStatus(`Computing matrix tile #${chunkId}...`);
	worker.postMessage({
		type: 'compute-matrix',
		payload: {
			taskId: Number(row.taskId),
			chunkId,
			rowStart: Number(row.rowStart),
			rowEnd: Number(row.rowEnd),
			colStart: Number(row.colStart),
			colEnd: Number(row.colEnd),
			aCols: Number(job.aCols),
			matrixA: matrices.matrixA,
			matrixB: matrices.matrixB,
		},
	});
}

worker.onmessage = event => {
	const { type, payload } = event.data ?? {};

	if (type === 'matrix-chunk-computed' && conn) {
		try {
			conn.reducers.submitResult({
				taskId: Number(payload.taskId),
				chunkId: BigInt(payload.chunkId),
				resultData: JSON.stringify(payload.tile),
			});
		} catch (error) {
			console.error('submit_result failed:', error);
			setStatus(`submit_result failed for tile #${payload.chunkId}.`);
		}

		activeChunkIds.delete(payload.chunkId.toString());
		setDonatedCount(getDonatedCount() + 1);
		setSolvedTiles(solvedTiles + 1);
		setStatus(`Submitted tile #${payload.chunkId}. Requesting more work...`);
		maybeClaimMatrixWork();
		return;
	}

	if (type === 'worker-error') {
		if (payload?.chunkId) {
			activeChunkIds.delete(payload.chunkId.toString());
		}
		console.error('Matrix worker error:', payload?.message);
		setStatus('Matrix worker error. See console for details.');
		maybeClaimMatrixWork();
	}
};

function connect() {
	DbConnection.builder()
		.withUri(SPACETIMEDB_URI)
		.withDatabaseName(DB_NAME)
		.onConnect(connection => {
			conn = connection;
			window.matrixConn = connection;
			myIdentityHex = connection.identity?.toHexString() ?? '';
			nodeIdEl.textContent = myIdentityHex ? `${myIdentityHex.slice(0, 12)}...` : 'unknown';

			connection.db.task.onInsert(() => {
				resolveMatrixTaskId();
				if (enabled) {
					maybeClaimMatrixWork();
				}
			});
			connection.db.task.onUpdate(() => {
				resolveMatrixTaskId();
				if (enabled) {
					maybeClaimMatrixWork();
				}
			});
			connection.db.matrixChunkQueue.onInsert((_ctx, row) => processMatrixChunkIfMine(row));
			connection.db.matrixChunkQueue.onUpdate((_ctx, _oldRow, row) => processMatrixChunkIfMine(row));

			const subscription = connection.subscriptionBuilder().onApplied(() => {
				resolveMatrixTaskId();
				setStatus('Connected. Enable Matrix Compute to contribute.');
				if (enabled) {
					maybeClaimMatrixWork();
				}
			});

			if (typeof subscription.subscribeToAllTables === 'function') {
				subscription.subscribeToAllTables();
			} else if (typeof subscription.subscribeToAll === 'function') {
				subscription.subscribeToAll();
			} else {
				subscription.subscribe([
					'SELECT * FROM task',
					'SELECT * FROM matrix_job_config',
					'SELECT * FROM matrix_chunk_queue',
					'SELECT * FROM node_status',
				]);
			}

			window.setInterval(() => {
				if (!enabled || !conn) {
					return;
				}
				for (const row of conn.db.matrixChunkQueue.iter()) {
					processMatrixChunkIfMine(row);
				}
				if (activeChunkIds.size === 0) {
					maybeClaimMatrixWork();
				}
			}, 1000);
		})
		.onDisconnect(() => {
			setStatus('Disconnected from SpaceTimeDB.');
		})
		.onConnectError((_ctx, err) => {
			console.error('Matrix node connection error:', err);
			setStatus('Failed to connect to SpaceTimeDB.');
		})
		.build();
}

toggleButton.addEventListener('click', () => {
	enabled = !enabled;
	toggleButton.textContent = enabled ? 'Disable Matrix Compute' : 'Enable Matrix Compute';

	if (enabled) {
		setStatus('Matrix compute enabled. Requesting work...');
		maybeClaimMatrixWork();
	} else {
		activeChunkIds.clear();
		clearMatrixCache();
		setStatus('Matrix compute paused.');
	}
});

setDonatedCount(getDonatedCount());
setSolvedTiles(0);
connect();
