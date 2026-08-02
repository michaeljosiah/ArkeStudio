@echo off
rem npm-style shim stand-in: the supervised command is this wrapper, and the real work is
rem the node grandchild it launches and waits on — exactly how opencode.cmd behaves.
"%ARKE_SHIM_NODE%" "%ARKE_SHIM_TARGET%" %*
