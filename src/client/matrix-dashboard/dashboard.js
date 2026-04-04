import { DbConnection } from '/module_bindings/index.js';

const SPACETIMEDB_URI = window.GRIDFORGOOD_URI ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = window.GRIDFORGOOD_DB_NAME ?? 'hack';
const MATRIX_DIM_LIMIT = 1000;

const matrixAEl = document.getElementById('matrix-a');
const matrixBEl = document.getElementById('matrix-b');
const matrixAFileEl = document.getElementById('matrix-a-file');
const matrixBFileEl = document.getElementById('matrix-b-file');
const tileSizeEl = document.getElementById('tile-size');
const submitJobEl = document.getElementById('submit-job');
const resetQueueEl = document.getElementById('reset-queue');
const statusEl = document.getElementById('status');

const jobStatusEl = document.getElementById('job-status');
const totalTilesEl = document.getElementById('total-tiles');
const completedTilesEl = document.getElementById('completed-tiles');
const progressEl = document.getElementById('progress');
const resultWrapEl = document.getElementById('result-wrap');

let conn = null;
let matrixTaskId = null;
let pendingSubmitSeq = 0;
let pendingSubmitTimer = null;

function setStatus(message) {
	statusEl.textContent = message;
}

function clearPendingSubmitCheck() {
	if (pendingSubmitTimer) {
		window.clearTimeout(pendingSubmitTimer);
		pendingSubmitTimer = null;
	}
}

function toFiniteNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function findFirstNumeric2dArray(value) {
	if (!value || typeof value !== 'object') {
		return null;
	}

	if (Array.isArray(value) && value.length > 0) {
		const maybeRows = value.map(row => (Array.isArray(row) ? row.map(toFiniteNumber) : null));
		const is2d = maybeRows.every(row => Array.isArray(row) && row.length > 0 && row.every(cell => cell !== null));
		if (is2d) {
			const width = maybeRows[0].length;
			if (maybeRows.every(row => row.length === width)) {
				return maybeRows;
			}
		}

		for (const item of value) {
			const nested = findFirstNumeric2dArray(item);
			if (nested) {
				return nested;
			}
		}
	}

	if (typeof value === 'object') {
		for (const nestedValue of Object.values(value)) {
			const nested = findFirstNumeric2dArray(nestedValue);
			if (nested) {
				return nested;
			}
		}
	}

	return null;
}

function collectNumbers(value, out) {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectNumbers(item, out);
		}
		return;
	}

	if (value && typeof value === 'object') {
		for (const nestedValue of Object.values(value)) {
			collectNumbers(nestedValue, out);
		}
		return;
	}

	const num = toFiniteNumber(value);
	if (num !== null) {
		out.push(num);
	}
}

function shapeFlatNumbersAsMatrix(numbers, source) {
	const rows = Number(source?.rows);
	const cols = Number(source?.cols);
	if (
		Number.isInteger(rows) &&
		Number.isInteger(cols) &&
		rows > 0 &&
		cols > 0 &&
		rows * cols === numbers.length
	) {
		const matrix = [];
		for (let r = 0; r < rows; r += 1) {
			const start = r * cols;
			matrix.push(numbers.slice(start, start + cols));
		}
		return matrix;
	}

	const n = Math.sqrt(numbers.length);
	if (Number.isInteger(n) && n > 0) {
		const matrix = [];
		for (let r = 0; r < n; r += 1) {
			const start = r * n;
			matrix.push(numbers.slice(start, start + n));
		}
		return matrix;
	}

	if (numbers.length > 0) {
		return [numbers];
	}

	return null;
}

function extractNumericMatrix(source) {
	const direct = findFirstNumeric2dArray(source);
	if (direct) {
		return direct;
	}

	const numbers = [];
	collectNumbers(source, numbers);
	return shapeFlatNumbersAsMatrix(numbers, source);
}

function normalizeMatrixJson(rawJson) {
	let parsed;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return { matrix: null, error: 'Invalid JSON.' };
	}

	const matrix = extractNumericMatrix(parsed);
	if (!matrix || matrix.length === 0 || matrix.some(row => !Array.isArray(row) || row.length === 0)) {
		return { matrix: null, error: 'No usable numeric matrix found in JSON.' };
	}

	const width = matrix[0].length;
	if (matrix.some(row => row.length !== width)) {
		return { matrix: null, error: 'Extracted matrix rows are not the same length.' };
	}

	return { matrix, error: null };
}

function resolveMatrixTaskId() {
	if (!conn) {
		matrixTaskId = null;
		return;
	}

	for (const task of conn.db.task.iter()) {
		if (task.taskKey === 'matrix_mul') {
			matrixTaskId = Number(task.taskId);
			return;
		}
	}

	matrixTaskId = null;
}

function getResolvedMatrixTaskId() {
	if (!conn) {
		return null;
	}

	resolveMatrixTaskId();
	if (matrixTaskId !== null) {
		return matrixTaskId;
	}

	const job = conn.db.matrixJobConfig.id.find(1);
	if (job?.taskId !== undefined && job?.taskId !== null) {
		const jobTaskId = Number(job.taskId);
		if (Number.isFinite(jobTaskId)) {
			matrixTaskId = jobTaskId;
			return matrixTaskId;
		}
	}

	for (const chunk of conn.db.matrixChunkQueue.iter()) {
		const chunkTaskId = Number(chunk.taskId);
		if (Number.isFinite(chunkTaskId)) {
			matrixTaskId = chunkTaskId;
			return matrixTaskId;
		}
	}

	return null;
}

async function applyJsonFileToTextarea(file, targetTextarea, label) {
	if (!file) {
		return;
	}

	let rawText;
	try {
		rawText = await file.text();
	} catch {
		setStatus(`Failed to read ${label} file.`);
		return;
	}

	const normalized = normalizeMatrixJson(rawText);
	if (!normalized.matrix) {
		setStatus(`${label} file error: ${normalized.error}`);
		return;
	}

	targetTextarea.value = JSON.stringify(normalized.matrix);
	setStatus(`${label} matrix loaded from ${file.name}.`);
}

function safeParseMatrixJson(value) {
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function renderMatrix(matrix) {
	if (!Array.isArray(matrix) || matrix.length === 0) {
		resultWrapEl.innerHTML = '<p>No result yet.</p>';
		return;
	}

	const table = document.createElement('table');
	for (const row of matrix) {
		const tr = document.createElement('tr');
		for (const cell of row) {
			const td = document.createElement('td');
			td.textContent = Number.isFinite(Number(cell)) ? `${Number(cell).toFixed(2)}` : `${cell}`;
			tr.appendChild(td);
		}
		table.appendChild(tr);
	}
	resultWrapEl.innerHTML = '';
	resultWrapEl.appendChild(table);
}

function renderDashboard() {
	if (!conn) {
		return;
	}

	const job = conn.db.matrixJobConfig.id.find(1);
	const chunks = Array.from(conn.db.matrixChunkQueue.iter());
	const totalTiles = chunks.length;
	const completedTiles = chunks.filter(chunk => chunk.status === 'completed').length;
	const progress = totalTiles > 0 ? Math.floor((completedTiles / totalTiles) * 100) : 0;

	totalTilesEl.textContent = `${totalTiles}`;
	completedTilesEl.textContent = `${completedTiles}`;
	progressEl.textContent = `${progress}%`;
	jobStatusEl.textContent = job?.status ?? 'no_job';

	if ((job || totalTiles > 0) && pendingSubmitSeq > 0) {
		pendingSubmitSeq = 0;
		clearPendingSubmitCheck();
		setStatus('Matrix job submitted. Waiting for nodes...');
	}

	if (job?.resultJson) {
		const matrix = safeParseMatrixJson(job.resultJson);
		renderMatrix(matrix);
	} else {
		renderMatrix(null);
	}
}

function clearMatrixInputs() {
	matrixAEl.value = '';
	matrixBEl.value = '';
	matrixAFileEl.value = '';
	matrixBFileEl.value = '';
}

function showDefaultDashboardState() {
	jobStatusEl.textContent = 'no_job';
	totalTilesEl.textContent = '0';
	completedTilesEl.textContent = '0';
	progressEl.textContent = '0%';
	renderMatrix(null);
}

submitJobEl.addEventListener('click', () => {
	if (!conn) {
		setStatus('Not connected yet.');
		return;
	}

	const matrixA = matrixAEl.value.trim();
	const matrixB = matrixBEl.value.trim();
	const tileSize = Number.parseInt(tileSizeEl.value, 10);

	if (!matrixA || !matrixB) {
		setStatus('Both matrices are required.');
		return;
	}

	const parsedA = normalizeMatrixJson(matrixA);
	const parsedB = normalizeMatrixJson(matrixB);
	if (!parsedA.matrix) {
		setStatus(`Matrix A error: ${parsedA.error}`);
		return;
	}
	if (!parsedB.matrix) {
		setStatus(`Matrix B error: ${parsedB.error}`);
		return;
	}

	const aCols = parsedA.matrix[0].length;
	const aRows = parsedA.matrix.length;
	const bRows = parsedB.matrix.length;
	const bCols = parsedB.matrix[0].length;
	if (aCols !== bRows) {
		setStatus(`Dimension mismatch: A is ${aRows}x${aCols} and B is ${bRows}x${bCols}.`);
		return;
	}

	if (aRows > MATRIX_DIM_LIMIT || aCols > MATRIX_DIM_LIMIT || bCols > MATRIX_DIM_LIMIT) {
		setStatus(`Matrix too large. Current limit is ${MATRIX_DIM_LIMIT} for rows/cols.`);
		return;
	}

	try {
		setStatus('Submitting matrix job...');
		const submitSeq = ++pendingSubmitSeq;
		clearPendingSubmitCheck();
		conn.reducers.submitMatrixJob({
			matrixAJson: JSON.stringify(parsedA.matrix),
			matrixBJson: JSON.stringify(parsedB.matrix),
			tileSize: Number.isNaN(tileSize) ? 8 : Math.max(1, tileSize),
		});

		pendingSubmitTimer = window.setTimeout(() => {
			if (submitSeq !== pendingSubmitSeq) {
				return;
			}
			if (!conn) {
				return;
			}
			pendingSubmitSeq = 0;
			const job = conn.db.matrixJobConfig.id.find(1);
			const hasMatrixChunks = Array.from(conn.db.matrixChunkQueue.iter()).length > 0;
			if (job || hasMatrixChunks) {
				setStatus('Matrix job submitted. Waiting for nodes...');
				return;
			}
			setStatus('Submit failed on backend. Check matrix format/dimensions and try again.');
			pendingSubmitTimer = null;
		}, 2500);
	} catch (error) {
		pendingSubmitSeq = 0;
		clearPendingSubmitCheck();
		setStatus(`Failed to submit job: ${error instanceof Error ? error.message : 'unknown error'}`);
	}
});

matrixAFileEl.addEventListener('change', async event => {
	const file = event.target?.files?.[0];
	await applyJsonFileToTextarea(file, matrixAEl, 'Matrix A');
});

matrixBFileEl.addEventListener('change', async event => {
	const file = event.target?.files?.[0];
	await applyJsonFileToTextarea(file, matrixBEl, 'Matrix B');
});

resetQueueEl.addEventListener('click', () => {
	if (!conn) {
		setStatus('Not connected yet.');
		return;
	}

	const resetTaskId = getResolvedMatrixTaskId();
	if (resetTaskId === null) {
		clearMatrixInputs();
		showDefaultDashboardState();
		setStatus('No active matrix job found. Inputs cleared.');
		return;
	}

	try {
		conn.reducers.resetTask({ taskId: resetTaskId });
		clearMatrixInputs();
		showDefaultDashboardState();
		setStatus('Matrix job reset: queue cleared and inputs reset.');
	} catch (error) {
		setStatus(`Failed to reset queue: ${error instanceof Error ? error.message : 'unknown error'}`);
	}
});

DbConnection.builder()
	.withUri(SPACETIMEDB_URI)
	.withDatabaseName(DB_NAME)
	.onConnect(connection => {
		conn = connection;
		window.matrixDashboardConn = connection;

		connection.db.task.onInsert(resolveMatrixTaskId);
		connection.db.task.onUpdate(resolveMatrixTaskId);

		connection.db.matrixJobConfig.onInsert(renderDashboard);
		connection.db.matrixJobConfig.onUpdate(renderDashboard);
		connection.db.matrixChunkQueue.onInsert(renderDashboard);
		connection.db.matrixChunkQueue.onUpdate(renderDashboard);

		const subscription = connection.subscriptionBuilder().onApplied(() => {
			resolveMatrixTaskId();
			setStatus('Connected. Submit matrices to start computation.');
			renderDashboard();
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
			]);
		}

		window.setInterval(renderDashboard, 1000);
	})
	.onConnectError((_ctx, err) => {
		console.error('Matrix dashboard connection error:', err);
		setStatus('Failed to connect to SpaceTimeDB.');
	})
	.build();
