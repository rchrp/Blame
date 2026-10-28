import {
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { lastFocusedAppWindow, onAppWindowFocus } from "./app-windows";

export function installApplicationMenu() {
  const ready = new WeakSet<WebContents>();
  const observed = new WeakSet<WebContents>();
  const projectAction = (action: "new" | "open") => {
    const window = lastFocusedAppWindow();
    if (!window || !ready.has(window.webContents)) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send("project-menu:action", action);
  };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          id: "new-project",
          label: "New Project…",
          accelerator: "CmdOrCtrl+N",
          enabled: false,
          click: () => projectAction("new"),
        },
        {
          id: "open-project",
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          enabled: false,
          click: () => projectAction("open"),
        },
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  const menu = Menu.buildFromTemplate(template);
  const update = () => {
    const window = lastFocusedAppWindow();
    const enabled = Boolean(window && ready.has(window.webContents));
    for (const id of ["new-project", "open-project"]) {
      menu.getMenuItemById(id)!.enabled = enabled;
    }
  };
  onAppWindowFocus(update);
  Menu.setApplicationMenu(menu);

  return (sender: WebContents, enabled: boolean) => {
    if (enabled) {
      if (!observed.has(sender)) {
        observed.add(sender);
        sender.once("destroyed", () => {
          ready.delete(sender);
          update();
        });
      }
      ready.add(sender);
    } else ready.delete(sender);
    update();
  };
}
