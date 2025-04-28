
# Testing Strategy

The testing methodology for the IGLM ecosystem adopts a structured, phased approach, ensuring verification of infrastructure, services, and integrations incrementally as components are built.

---

## Testing Phases

### Phase 0: Infrastructure & Configs
- **Objective:** Confirm that the foundational infrastructure and configurations are operational.
- **Tasks:**
  - Verify all infrastructure services are up and running.
  - Validate that the Config DB is correctly populated with initial entries.
- **Status:** ✅ Completed.

---

### Phase 1: Identity Collection Service (ICS) Isolation
- **Objective:** Validate the ICS service in isolation.
- **Tasks:**
  - Test data pulling from HRMS or identity sources.
  - Verify delta detection and snapshotting mechanisms.
  - Confirm MQ message publication (inspect via MQ UI).
- **Status:** 🔄 Ready for Verification.

---

### Phase 2: Lifecycle Services + Provisioning API
- **Objective:** Validate Joiners, Movers, Leavers (JML) and Provisioning API integrations.
- **Tasks:**
  - Test JML and Leaver modules consuming events.
  - Verify Role Assignment workflows.
  - Confirm successful API calls to the Provisioning Service.
  - Validate that Provisioning Tasks are created and queued in DB and MQ.
- **Preconditions:** Provisioning Service API must be running.

---

### Phase 3: Provisioning Worker + Adapter Execution
- **Objective:** Verify task execution by the Provisioning Worker and Adapter functionality.
- **Tasks:**
  - Test the Worker consuming tasks from MQ.
  - Verify adapter invocations and correct execution.
  - Validate actions on target systems or mock systems.
- **Preconditions:** Target systems or mock endpoints and fully implemented Adapters.

---

### Phase 4: Discovery Service + Reconciliation
- **Objective:** Test Discovery and Reconciliation end-to-end integration.
- **Tasks:**
  - Run Discovery Service to pull current state.
  - Store discovered access states properly.
  - Trigger Reconciliation logic.
  - Identify and store discrepancies (Violations, Orphans, Missing Access).
  - Verify Remediation actions triggered through the Provisioning API.
- **Preconditions:** Target systems/mocks operational; Provisioning Service API running.

---

### Phase 5: End-to-End Flow
- **Objective:** Validate the complete operational pipeline.
- **Tasks:**
  - Simulate an HRMS change (e.g., a new hire, role change).
  - Walk the change through ICS, Lifecycle Services, Provisioning, Discovery, Reconciliation.
  - Confirm updates propagated to the target systems.
  - Ensure discrepancies are detected and auto-remediated.

---

## Summary

This phased strategy mitigates risk by progressively validating each component and its integration touchpoints before full system-wide testing. It ensures quality assurance across microservices, workflows, data propagation, and external system interactions.

---
