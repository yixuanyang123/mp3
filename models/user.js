// Load required packages
var mongoose = require('mongoose');

// Define our user schema
var UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    pendingTasks: { type: [String], default: [] },
    dateCreated: { type: Date, default: Date.now }
});

// Create index for unique email
UserSchema.index({ email: 1 }, { unique: true });

// Export the Mongoose model
module.exports = mongoose.model('User', UserSchema);
