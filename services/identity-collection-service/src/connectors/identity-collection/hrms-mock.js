// services/identity-collection-service/src/connectors/identity-collection/hrms-mock.js

/**
 * Mock HRMS Connector Adapter.
 * Simulates collecting data from an HRMS for testing purposes.
 */

/**
 * Simulates pulling raw HRMS data.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Could contain mock-specific settings, e.g., { "scenario": "initial_load" }.
 * @param {Date|null} lastRunTimestamp - The end time of the last successful collection run.
 * Can be used to simulate incremental data changes.
 * @returns {Promise<Array<object>>} A promise resolving with an array of mock HRMS records.
 * @throws {Error} Can throw errors to simulate connection failures or data issues.
 */
async function collectData(configDetails, lastRunTimestamp) {
    console.log(`[HRMS-Mock Connector] Simulating data collection.`);
    console.log(`[HRMS-Mock Connector] Config:`, configDetails);
    console.log(`[HRMS-Mock Connector] Last Run Timestamp:`, lastRunTimestamp);

    // Simulate a delay for network latency or processing time
    await new Promise(resolve => setTimeout(resolve, 500));

    // --- Simulate returning different data based on scenario or timestamp ---

    let mockData = [];

    // Base data set
    const baseUsers = [
        {
            person_id: 'p0001', employee_id: 'e001', first_name: 'Alice', middle_name: null, last_name: 'Smith', date_of_hire: '2022-01-15', job_title: 'Software Engineer', supervisor_id: 'e010', head_of_office_id: null, job_location_id: 'L1', job_location: 'New York', mobile_number: '555-1111', department_id: 'D01', department_name: 'IT', division_id: 'V1', division_name: 'Engineering', office_id: null, office_name: null, grade_id: 'G5', grade: 'Grade 5', party_id: 'pty001', termination_date: null, job_status: 'Active', email: 'alice.smith@example.com'
        },
        {
            person_id: 'p0002', employee_id: 'e002', first_name: 'Bob', middle_name: 'A.', last_name: 'Johnson', date_of_hire: '2023-03-10', job_title: 'Project Manager', supervisor_id: 'e011', head_of_office_id: null, job_location_id: 'L2', job_location: 'London', mobile_number: '555-2222', department_id: 'D02', department_name: 'Marketing', division_id: 'V2', division_name: 'Operations', office_id: null, office_name: null, grade_id: 'G6', grade: 'Grade 6', party_id: 'pty002', termination_date: null, job_status: 'Active', email: 'bob.johnson@example.com'
        },
         {
            person_id: 'p0003', employee_id: 'e003', first_name: 'Charlie', middle_name: null, last_name: 'Brown', date_of_hire: '2024-05-20', job_title: 'Data Analyst', supervisor_id: 'e010', head_of_office_id: null, job_location_id: 'L1', job_location: 'New York', mobile_number: '555-3333', department_id: 'D01', department_name: 'IT', division_id: 'V1', division_name: 'Engineering', office_id: null, office_name: null, grade_id: 'G5', grade: 'Grade 5', party_id: 'pty003', termination_date: null, job_status: 'Active', email: 'charlie.brown@example.com'
        },
    ];

    // Simulate initial load vs subsequent runs
    if (!lastRunTimestamp || configDetails?.scenario === 'initial_load') {
         console.log("[HRMS-Mock Connector] Simulating initial load.");
         mockData = [...baseUsers]; // Return all base users
    } else {
        console.log("[HRMS-Mock Connector] Simulating changes since last run.");
        // Simulate a mover (Bob changed department and title)
        const bobMover = {
            person_id: 'p0002', employee_id: 'e002', first_name: 'Bob', middle_name: 'A.', last_name: 'Johnson', date_of_hire: '2023-03-10', job_title: 'Senior Project Manager', supervisor_id: 'e011', head_of_office_id: null, job_location_id: 'L2', job_location: 'London', mobile_number: '555-2222', department_id: 'D03', department_name: 'Product', division_id: 'V2', division_name: 'Operations', office_id: null, office_name: null, grade_id: 'G7', grade: 'Grade 7', party_id: 'pty002', termination_date: null, job_status: 'Active', email: 'bob.johnson@example.com' // Email might also change
        };

        // Simulate a leaver (Charlie left)
        const charlieLeaver = {
             person_id: 'p0003', employee_id: 'e003', first_name: 'Charlie', middle_name: null, last_name: 'Brown', date_of_hire: '2024-05-20', job_title: 'Data Analyst', supervisor_id: 'e010', head_of_office_id: null, job_location_id: 'L1', job_location: 'New York', mobile_number: '555-3333', department_id: 'D01', department_name: 'IT', division_id: 'V1', division_name: 'Engineering', office_id: null, office_name: null, grade_id: 'G5', grade: 'Grade 5', party_id: 'pty003', termination_date: new Date().toISOString(), job_status: 'Terminated', email: 'charlie.brown@example.com'
        };


        // Simulate a joiner (David is new)
        const davidJoiner = {
             person_id: 'p0004', employee_id: 'e004', first_name: 'David', middle_name: null, last_name: 'Green', date_of_hire: new Date().toISOString(), job_title: 'QA Engineer', supervisor_id: 'e010', head_of_office_id: null, job_location_id: 'L1', job_location: 'New York', mobile_number: '555-4444', department_id: 'D01', department_name: 'IT', division_id: 'V1', division_name: 'Engineering', office_id: null, office_name: null, grade_id: 'G5', grade: 'Grade 5', party_id: 'pty004', termination_date: null, job_status: 'Pending Hire', email: 'david.green@example.com'
        };


        // Return data including Alice (unchanged), Bob (mover), David (joiner), but exclude Charlie (leaver is detected by absence)
        mockData = [
            baseUsers[0], // Alice (unchanged)
            bobMover,    // Bob (changed)
            davidJoiner  // David (new)
        ];
         // Note: Leavers are typically detected by their *absence* in the current full data pull,
         // unless the HRMS provides specific leaver events or flags. Our current DeltaDetection
         // handles leavers by absence.
    }

    console.log(`[HRMS-Mock Connector] Simulated returning ${mockData.length} records.`);
    return Promise.resolve(mockData); // Resolve with the mock data array
}

module.exports = {
    collectData,
};