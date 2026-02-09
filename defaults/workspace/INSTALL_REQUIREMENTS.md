# INSTALL REQUIREMENTS

Use this file for dependencies that cannot be installed in user space.

Status: keep entries with `open` until the image/runtime is updated.

## Template

### Dependency: <name>
- status: open
- blocking_task: <task id/title>
- failure_evidence: <command/error excerpt>
- suggested_dockerfile_snippet:
```dockerfile
# Example
# RUN apt-get update && apt-get install -y <package>
```
- opened_at: <iso timestamp>
- resolved_at: <iso timestamp or empty>

