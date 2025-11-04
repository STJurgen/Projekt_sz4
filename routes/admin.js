const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get('/orders', adminController.getOrders);
router.post('/orders/:orderId/status', adminController.updateOrderStatus);

router.post('/messages', adminController.sendMessage);

router.get('/users', adminController.getUsers);
router.post('/users/:userId/role', adminController.updateUserRole);
router.delete('/users/:userId', adminController.deleteUser);

router.post('/commands', adminController.runCommand);
router.get('/export/orders', adminController.exportOrders);

module.exports = router;
