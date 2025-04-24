// services/identity-collection-service/src/deltaDetection.js

/**
 * Compares a previous snapshot of HRMS data with a current one to detect deltas (Joiners, Movers, Leavers).
 * Snapshots are assumed to be Maps or objects keyed by the HRMS unique identifier.
 *
 * @param {object} previousSnapshotMap - Map of HRMS records from the previous successful run (keyed by uniqueIdField).
 * @param {object} currentSnapshotMap - Map of HRMS records from the current collection run (keyed by uniqueIdField).
 * @param {string} uniqueIdField - The name of the HRMS attribute used as the unique identifier key in the maps.
 * @returns {{joiners: Array<object>, movers: Array<object>, leavers: Array<object>}} Object containing arrays of delta records.
 * @throws {Error} If input is invalid.
 */
function compareSnapshots(previousSnapshotMap, currentSnapshotMap, uniqueIdField) {
    console.log(`[DeltaDetection] Starting snapshot comparison using unique field "${uniqueIdField}".`);

    if (typeof previousSnapshotMap !== 'object' || previousSnapshotMap === null ||
        typeof currentSnapshotMap !== 'object' || currentSnapshotMap === null ||
        typeof uniqueIdField !== 'string' || !uniqueIdField) {
        throw new Error("Invalid input for compareSnapshots. Snapshots must be objects, uniqueIdField a non-empty string.");
    }

    const joiners = [];
    const movers = [];
    const leavers = [];

    const previousKeys = Object.keys(previousSnapshotMap);
    const currentKeys = Object.keys(currentSnapshotMap);

    const previousKeySet = new Set(previousKeys);
    const currentKeySet = new Set(currentKeys);

    // 1. Find Joiners: Keys in currentSnapshotMap but not in previousSnapshotMap
    for (const key of currentKeys) {
        if (!previousKeySet.has(key)) {
            console.log(`[DeltaDetection] Found Joiner (new key): ${key}`);
            joiners.push(currentSnapshotMap[key]);
        }
    }

    // 2. Find Leavers: Keys in previousSnapshotMap but not in currentSnapshotMap
    for (const key of previousKeys) {
        if (!currentKeySet.has(key)) {
            console.log(`[DeltaDetection] Found Leaver (missing key): ${key}`);
            leavers.push(previousSnapshotMap[key]); // Return the record as it was in the previous snapshot
        }
    }

    // 3. Find Movers: Keys present in both, but data has changed
    // IMPORTANT: This is a simple comparison (JSON.stringify). A more robust approach
    // would compare specific attributes flagged as 'mover' relevant in the MappingConfig.
    for (const key of currentKeys) {
        if (previousKeySet.has(key)) { // If the key exists in both
            const previousRecord = previousSnapshotMap[key];
            const currentRecord = currentSnapshotMap[key];

            // Simple deep comparison by stringifying
            const previousString = JSON.stringify(previousRecord);
            const currentString = JSON.stringify(currentRecord);

            if (previousString !== currentString) {
                 console.log(`[DeltaDetection] Found Mover (data changed for key): ${key}`);
                movers.push(currentRecord); // Return the updated record
            }
        }
    }

    console.log(`[DeltaDetection] Snapshot comparison completed. Joiners: ${joiners.length}, Movers: ${movers.length}, Leavers: ${leavers.length}`);

    return { joiners, movers, leavers };
}

module.exports = {
  compareSnapshots,
};