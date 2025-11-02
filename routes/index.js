/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    const express = require('express');

    // Provide a friendly root response instead of "Cannot GET /"
    app.get('/', function (req, res) {
        res.status(200).json({
            message: 'Welcome to the MP3 API. See /api for the entrypoint.',
            data: {
                docs: '/api',
                endpoints: ['/api', '/api/users', '/api/tasks']
            }
        });
    });

    // Home route at /api
    app.use('/api', require('./home.js')(express.Router()));

    // Users and Tasks APIs
    app.use('/api/users', require('./users.js')(express.Router()));
    app.use('/api/tasks', require('./tasks.js')(express.Router()));
};
