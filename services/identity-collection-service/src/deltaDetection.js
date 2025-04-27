/**
 * Enhanced Delta-Detection Utility
 * ------------------------------------------------------------
 * Compares two HRMS snapshots and detects changes with improved:
 * - Field-level comparison for movers
 * - Debugging capabilities
 * - Performance optimizations
 */

function compareSnapshots(previousSnapshotMap, currentSnapshotMap, uniqueIdField) {
    const svc = 'DeltaDetection';
  
    /* ---------- 0. Input Validation ---------- */
    if (
      !previousSnapshotMap || typeof previousSnapshotMap !== 'object' ||
      !currentSnapshotMap || typeof currentSnapshotMap !== 'object' ||
      typeof uniqueIdField !== 'string' || !uniqueIdField.trim()
    ) {
      throw new Error(`${svc} › Invalid arguments`);
    }
  
    console.log(`[${svc}] Starting comparison with UID field "${uniqueIdField}"`);
    console.log(`[${svc}] Previous records: ${Object.keys(previousSnapshotMap).length} | Current records: ${Object.keys(currentSnapshotMap).length}`);
  
    /* ---------- 1. Initialize Results ---------- */
    const results = {
      joiners: [],
      movers: [],
      leavers: [],
      unchanged: 0,
      changeDetails: {}
    };
  
    const prevKeys = new Set(Object.keys(previousSnapshotMap));
    const currKeys = new Set(Object.keys(currentSnapshotMap));
  
    /* ---------- 2. Debug Initial State ---------- */
    if (process.env.DEBUG_DELTA) {
      console.debug(`[${svc}] Sample previous records:`, 
        Array.from(prevKeys).slice(0, 3).map(id => ({ id, ...previousSnapshotMap[id] })));
      console.debug(`[${svc}] Sample current records:`, 
        Array.from(currKeys).slice(0, 3).map(id => ({ id, ...currentSnapshotMap[id] })));
    }
  
    /* ---------- 3. Detect Changes ---------- */
    // Track all processed IDs to detect joiners efficiently
    const processedIds = new Set();
  
    // First pass: Check for leavers and changed records (movers)
    for (const id of prevKeys) {
      const prevRec = previousSnapshotMap[id];
      
      if (!currKeys.has(id)) {
        // Leaver detected
        results.leavers.push(prevRec);
        results.changeDetails[id] = { type: 'leaver', timestamp: new Date() };
        continue;
      }
  
      // Record exists in both snapshots - check for changes
      processedIds.add(id);
      const currRec = currentSnapshotMap[id];
      const changes = findRecordChanges(prevRec, currRec);
  
      if (changes.length > 0) {
        results.movers.push({
          id,
          previous: prevRec,
          current: currRec,
          changedFields: changes
        });
        results.changeDetails[id] = {
          type: 'mover',
          changedFields: changes,
          timestamp: new Date()
        };
      } else {
        results.unchanged++;
      }
    }
  
    // Second pass: Detect joiners (records in current but not previous)
    for (const id of currKeys) {
      if (!processedIds.has(id) && !prevKeys.has(id)) {
        results.joiners.push(currentSnapshotMap[id]);
        results.changeDetails[id] = { type: 'joiner', timestamp: new Date() };
      }
    }
  
    /* ---------- 4. Final Reporting ---------- */
    console.log(`[${svc}] Results - Joiners: ${results.joiners.length}, ` +
      `Movers: ${results.movers.length}, Leavers: ${results.leavers.length}, ` +
      `Unchanged: ${results.unchanged}`);
  
    if (process.env.DEBUG_DELTA && results.movers.length > 0) {
      console.debug(`[${svc}] Sample changes:`, 
        results.movers.slice(0, 3).map(m => ({
          id: m.id,
          changes: m.changedFields
        })));
    }
  
    return results;
  }
  
  /**
   * Performs detailed field-by-field comparison between two records
   */
  function findRecordChanges(prevRec, currRec) {
    const changes = [];
    const allFields = new Set([
      ...Object.keys(prevRec || {}),
      ...Object.keys(currRec || {})
    ]);
  
    for (const field of allFields) {
      const prevValue = prevRec[field];
      const currValue = currRec[field];
  
      // Handle special cases
      if (field === 'termination_date' || field === 'date_of_hire') {
        if (!dateEquals(prevValue, currValue)) {
          changes.push(field);
        }
        continue;
      }
  
      // General comparison
      if (!deepEqual(prevValue, currValue)) {
        changes.push(field);
      }
    }
  
    return changes;
  }
  
  /**
   * Deep comparison of values (handles objects, arrays, dates)
   */
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
  
    if (typeof a === 'object' && a !== null && b !== null) {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      
      return aKeys.every(key => deepEqual(a[key], b[key]));
    }
  
    return false;
  }
  
  /**
   * Special date comparison handling
   */
  function dateEquals(date1, date2) {
    if (date1 === date2) return true;
    if (!date1 || !date2) return false;
    
    const d1 = date1 instanceof Date ? date1 : new Date(date1);
    const d2 = date2 instanceof Date ? date2 : new Date(date2);
    
    return d1.getTime() === d2.getTime();
  }
  
  module.exports = { compareSnapshots };