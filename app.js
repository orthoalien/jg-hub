(function () {
  const STORAGE_KEY = "jg-hub-order-v1";

  function loadOrder() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      return {};
    }
  }

  function saveOrder() {
    const order = {};
    document.querySelectorAll(".grid").forEach(function (grid) {
      const section = grid.getAttribute("data-section");
      order[section] = Array.from(grid.querySelectorAll(".tile")).map(function (tile) {
        return tile.getAttribute("data-id");
      });
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  }

  function applySavedOrder() {
    const order = loadOrder();
    document.querySelectorAll(".grid").forEach(function (grid) {
      const section = grid.getAttribute("data-section");
      const ids = order[section];
      if (!ids || !ids.length) return;
      const tiles = {};
      Array.from(grid.querySelectorAll(".tile")).forEach(function (tile) {
        tiles[tile.getAttribute("data-id")] = tile;
      });
      ids.forEach(function (id) {
        if (tiles[id]) grid.appendChild(tiles[id]);
      });
    });
  }

  applySavedOrder();

  document.querySelectorAll(".grid").forEach(function (grid) {
    Sortable.create(grid, {
      animation: 160,
      ghostClass: "sortable-ghost",
      dragClass: "sortable-drag",
      delayOnTouchOnly: true,
      delay: 120,
      onEnd: saveOrder
    });
  });
})();
