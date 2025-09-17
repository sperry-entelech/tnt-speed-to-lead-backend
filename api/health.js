/**
 * TNT Corporate Lead System - Simple Health Check
 */

module.exports = (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'TNT Corporate Lead System',
    timestamp: new Date().toISOString(),
    message: 'TNT Lead System is operational!'
  });
};