// Envuelve un handler async de Express para que los errores lleguen al
// middleware de manejo de errores en vez de colgar el request.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
