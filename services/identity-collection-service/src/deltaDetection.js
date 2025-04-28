// services/identity-collection-service/src/deltaDetection.js

/**
 * Delta-Detection Utility
 * ------------------------------------------------------------
 * Compares two HRMS snapshots keyed by a unique identifier and
 * classifies records as JOINERS (new), MOVERS (changed), or
 * LEAVERS (removed).
 *
 * @param {Object.<string, Object>} previousSnapshotMap  – prior snapshot keyed by uniqueId
 * @param {Object.<string, Object>} currentSnapshotMap   – latest snapshot keyed by uniqueId
 * @param {string}                  uniqueIdField        – name of the HRMS UID column
 *
 * @returns {{
*   joiners : Object[],
*   movers  : { previous: Object, current: Object }[],
*   leavers : Object[]
* }}
*
* @throws {Error} on invalid inputs
*/
function compareSnapshots (previousSnapshotMap, currentSnapshotMap, uniqueIdField) {
 const svc = 'DeltaDetection';

 /* ---------- 0. Input Validation ---------- */
 if (
   !previousSnapshotMap || typeof previousSnapshotMap !== 'object' ||
   !currentSnapshotMap || typeof currentSnapshotMap !== 'object' ||
   typeof uniqueIdField !== 'string' || !uniqueIdField.trim()
 ) {
   throw new Error(`${svc} › Invalid arguments`);
 }

 console.log(`[${svc}] Starting comparison with UID field “${uniqueIdField}”.`);
 console.log(`[${svc}] Previous records: ${Object.keys(previousSnapshotMap).length} | Current records: ${Object.keys(currentSnapshotMap).length}`);
 
 /* ---------- 1. Initialize Results ---------- */
 const joiners = [];
 const movers  = [];
 const leavers = [];

 // Use Sets for efficient key lookup
 const prevKeys = new Set(Object.keys(previousSnapshotMap));
 const currKeys = new Set(Object.keys(currentSnapshotMap));

 // --- Add logging here ---
 console.log(`[${svc}] Debugging: Using Sets for comparison.`);
 console.log(`[${svc}] Debugging: prevKeys size: ${prevKeys.size}, currKeys size: ${currKeys.size}`);
 console.log(`[${svc}] Debugging: Sample prevKeys:`, Array.from(prevKeys).slice(0, 5));
 console.log(`[${svc}] Debugging: Sample currKeys:`, Array.from(currKeys).slice(0, 5));
 // --- End logging ---


 /* ---------- 2. Leavers & Movers ---------- */
 // Iterate through the keys from the previous snapshot
 for (const id of prevKeys) {
   const prevRec = previousSnapshotMap[id];

   if (!currKeys.has(id)) {
     // — Leaver: ID is in previous but NOT in current
     console.log(`[${svc}] Leaver › ${id}`);
     leavers.push(prevRec);
   } else {
     // Candidate Mover: ID is in both snapshots
     const currRec = currentSnapshotMap[id];
     // Check if the record's content has changed
     if (JSON.stringify(prevRec) !== JSON.stringify(currRec)) {
       console.log(`[${svc}] Mover  › ${id}`);
       movers.push({ previous: prevRec, current: currRec });
     }
   }
 }

 /* ---------- 3. Joiners ---------- */
 // Iterate through the keys from the current snapshot
 console.log('[DeltaDetection] Checking for Joiners...'); // Add log before joiner loop
 for (const id of currKeys) {
   // --- Add logging inside the joiner loop ---
   const existsInPrevious = prevKeys.has(id); // Correct check using Set.has()
   // console.log(`[${svc}] Checking current ID "${id}": Exists in previous? ${existsInPrevious}`); // Too verbose for 3k+ records, use for focused debug
   // --- End logging ---

   if (!prevKeys.has(id)) { // Check if the current ID is NOT in the set of previous keys
     // — Joiner: ID is in current but NOT in previous
     console.log(`[${svc}] Joiner › ${id}`);
     joiners.push(currentSnapshotMap[id]);
   }
   // Note: Movers (IDs in both) are already handled in the first loop, so we don't need an else here.
 }

 /* ---------- 4. Integrity Alerts ---------- */
 // These checks ensure that the maps were created correctly with unique keys,
 // which is a dependency on the snapshot creation logic in collectionLogic.js.
 if (Object.keys(previousSnapshotMap).length !== prevKeys.size)  {
   console.warn(`[${svc}] Warning: Discrepancy between Object.keys and Set size for previous snapshot.`);
 }
 if (Object.keys(currentSnapshotMap).length  !== currKeys.size)  {
   console.warn(`[${svc}] Warning: Discrepancy between Object.keys and Set size for current snapshot.`);
 }

 console.log(
   `[${svc}] Completed. Joiners: ${joiners.length}, Movers: ${movers.length}, Leavers: ${leavers.length}`
 );

 return { joiners, movers, leavers };
}

module.exports = { compareSnapshots };