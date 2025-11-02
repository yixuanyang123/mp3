/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    const express = require('express');

    // Home route at /api
    app.use('/api', require('./home.js')(express.Router()));

    // Users and Tasks APIs
    app.use('/api/users', require('./users.js')(express.Router()));
    app.use('/api/tasks', require('./tasks.js')(express.Router()));
};
