import { cn } from "@/lib/utils";
import { File, Folder } from "lucide-react";

export interface ExplorerFile {
  path: string;
  type: string;
}

interface ProjectExplorerProps {
  files: ExplorerFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export function ProjectExplorer({
  files,
  selectedPath,
  onSelect,
}: ProjectExplorerProps) {
  const tree = buildTree(files);

  return (
    <div className="h-full overflow-auto p-3 text-sm">
      <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Files
      </div>
      <ul className="space-y-0.5">
        {tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            selectedPath={selectedPath}
            onSelect={onSelect}
            level={0}
          />
        ))}
      </ul>
    </div>
  );
}

interface TreeNodeData {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNodeData[];
}

function buildTree(files: ExplorerFile[]): TreeNodeData[] {
  const root: TreeNodeData = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;
      let child = current.children.find((c) => c.name === part);

      if (!child) {
        child = {
          name: part,
          path: currentPath,
          isDirectory: !isLast,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  return root.children;
}

function TreeNode({
  node,
  selectedPath,
  onSelect,
  level,
}: {
  node: TreeNodeData;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  level: number;
}) {
  const isSelected = selectedPath === node.path;

  if (node.isDirectory) {
    return (
      <li className="select-none">
        <div
          className={cn(
            "flex items-center gap-2 rounded-md py-1 pr-2 pl-2 font-medium text-foreground",
            level > 0 && "ml-4",
          )}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
        >
          <Folder className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{node.name}</span>
        </div>
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              level={level + 1}
            />
          ))}
        </ul>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 transition-colors hover:bg-muted",
        isSelected && "bg-muted",
        level > 0 && "ml-4",
      )}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      onClick={() => onSelect(node.path)}
    >
      <File className="h-3.5 w-3.5 text-muted-foreground" />
      <span
        className={cn(
          "text-xs",
          isSelected ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {node.name}
      </span>
    </li>
  );
}
