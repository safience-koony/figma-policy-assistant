figma.showUI(__html__, { width: 360, height: 560, themeColors: true });

function selectionTarget(node) {
  let current = node;
  while (current.parent && !['FRAME', 'COMPONENT', 'INSTANCE', 'SECTION'].includes(current.type)) {
    current = current.parent;
  }
  return current;
}

function publishSelection() {
  const selection = figma.currentPage.selection;
  if (!selection.length) {
    figma.ui.postMessage({ type: 'selection', selection: null });
    return;
  }

  const target = selectionTarget(selection[0]);
  const textNodes = [];
  const visit = (node) => {
    if (node.type === 'TEXT' && node.characters.trim()) {
      textNodes.push({ id: node.id, name: node.name, characters: node.characters });
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(target);
  figma.ui.postMessage({
    type: 'selection',
    selection: {
      nodeId: target.id,
      nodeName: target.name,
      nodeType: target.type,
      documentName: figma.root.name,
      selectionCount: selection.length,
      textNodes,
      updatedAt: new Date().toISOString(),
    },
  });
}

figma.on('selectionchange', publishSelection);
figma.on('currentpagechange', publishSelection);
publishSelection();
