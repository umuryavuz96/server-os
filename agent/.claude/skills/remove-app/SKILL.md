---
name: remove-app
description: Uninstall an app that Server OS installed, keeping or deleting its data. Use for "remove X", "uninstall X", "get rid of X".
---

# Remove an app

1. `list_apps` and `../apps/<id>/app.yaml`. Only apps with an `app.yaml` were installed by Server OS.
   - For anything else, explain how it was installed (`parts` in `list_apps`) and ask how the owner wants it removed.
2. Tell the owner what goes and what stays. Containers and packages go; `data/` stays unless purged. **Ask** before uninstalling.
3. `uninstall_app` with `purge: false` unless the owner explicitly said to delete the data. Poll `operation_status`.
4. Confirm it is gone from `list_apps`. Mention where the data is kept (`../apps/<id>/data`) if it was not purged.
