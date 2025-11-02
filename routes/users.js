module.exports = function (router) {
    var User = require('../models/user');
    var Task = require('../models/task');

    function ok(res, data, code, message) {
        res.status(code || 200).json({ message: message || 'OK', data: data });
    }

    function fail(res, code, message, data) {
        res.status(code || 500).json({ message: message || 'Server Error', data: data || {} });
    }

    function parseJSONParam(paramStr) {
        if (paramStr === undefined) return undefined;
        try { return JSON.parse(paramStr); } catch (e) { return { __parseError: true, error: e }; }
    }

    async function assignTaskToUser(taskId, user) {
        const task = await Task.findById(taskId);
        if (!task) return { skipped: true };

        // If assigned to someone else, remove from their pendingTasks
        if (task.assignedUser && task.assignedUser !== String(user._id)) {
            const prevUser = await User.findById(task.assignedUser);
            if (prevUser) {
                prevUser.pendingTasks = (prevUser.pendingTasks || []).filter(tid => String(tid) !== String(task._id));
                await prevUser.save();
            }
        }

        task.assignedUser = String(user._id);
        task.assignedUserName = user.name;
        await task.save();

        // Only pending tasks should be in pendingTasks
        if (!task.completed) {
            const set = new Set((user.pendingTasks || []).map(String));
            set.add(String(task._id));
            user.pendingTasks = Array.from(set);
            await user.save();
        } else {
            user.pendingTasks = (user.pendingTasks || []).filter(tid => String(tid) !== String(task._id));
            await user.save();
        }
        return { updated: true };
    }

    async function unassignTask(taskId) {
        const task = await Task.findById(taskId);
        if (!task) return { skipped: true };
        if (task.assignedUser) {
            const u = await User.findById(task.assignedUser);
            if (u) {
                u.pendingTasks = (u.pendingTasks || []).filter(tid => String(tid) !== String(task._id));
                await u.save();
            }
        }
        task.assignedUser = "";
        task.assignedUserName = "unassigned";
        await task.save();
        return { updated: true };
    }

    // GET / -> list users with query params
    router.get('/', async function (req, res) {
        const where = parseJSONParam(req.query.where) || {};
        const sort = parseJSONParam(req.query.sort);
        const select = parseJSONParam(req.query.select);
        const skip = req.query.skip ? parseInt(req.query.skip, 10) : undefined;
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined; // users: default unlimited
        const count = (req.query.count === true || req.query.count === 'true');

        if ((where && where.__parseError) || (sort && sort.__parseError) || (select && select.__parseError)) {
            return fail(res, 400, 'Invalid JSON in query parameters');
        }

        try {
            if (count) {
                const c = await User.countDocuments(where || {});
                return ok(res, c);
            }
            let q = User.find(where || {});
            if (select) q = q.select(select);
            if (sort) q = q.sort(sort);
            if (skip !== undefined) q = q.skip(skip);
            if (limit !== undefined) q = q.limit(limit);
            const docs = await q.exec();
            return ok(res, docs);
        } catch (e) {
            return fail(res, 500, 'Failed to fetch users');
        }
    });

    // POST / -> create user
    router.post('/', async function (req, res) {
        try {
            const { name, email, pendingTasks } = req.body || {};
            if (!name || !email) return fail(res, 400, 'User must have name and email');

            let user = new User({ name, email, pendingTasks: [] });
            await user.save();

            // Handle pendingTasks assignment if provided
            if (Array.isArray(pendingTasks) && pendingTasks.length > 0) {
                for (const tid of pendingTasks) {
                    await assignTaskToUser(tid, user);
                }
                // Reload user after updates
                user = await User.findById(user._id);
            }

            return ok(res, user, 201, 'User created');
        } catch (e) {
            if (e && e.code === 11000) {
                return fail(res, 400, 'A user with the given email already exists');
            }
            return fail(res, 500, 'Failed to create user');
        }
    });

    // GET /:id -> get user by id (with select)
    router.get('/:id', async function (req, res) {
        const select = parseJSONParam(req.query.select);
        if (select && select.__parseError) return fail(res, 400, 'Invalid JSON in select parameter');
        try {
            let q = User.findById(req.params.id);
            if (select) q = q.select(select);
            const user = await q.exec();
            if (!user) return fail(res, 404, 'User not found');
            return ok(res, user);
        } catch (e) {
            return fail(res, 500, 'Failed to fetch user');
        }
    });

    // PUT /:id -> replace entire user and sync pendingTasks
    router.put('/:id', async function (req, res) {
        try {
            const body = req.body || {};
            if (!body.name || !body.email) return fail(res, 400, 'User must have name and email');

            let user = await User.findById(req.params.id);
            if (!user) return fail(res, 404, 'User not found');

            // Update base fields first
            user.name = body.name;
            user.email = body.email;
            await user.save();

            const newPending = Array.isArray(body.pendingTasks) ? body.pendingTasks.map(String) : [];

            // Determine all tasks currently assigned to this user (ensure coverage even if not in pendingTasks field)
            const currentlyAssigned = await Task.find({ assignedUser: String(user._id) });
            const currentIds = currentlyAssigned.map(t => String(t._id));

            // Unassign tasks that are not in newPending
            for (const tid of currentIds) {
                if (!newPending.includes(String(tid))) {
                    await unassignTask(tid);
                }
            }

            // Assign tasks in newPending to this user
            for (const tid of newPending) {
                await assignTaskToUser(tid, user);
            }

            // Reload and ensure user.pendingTasks only contains pending tasks assigned to user
            const stillAssignedPending = await Task.find({ assignedUser: String(user._id), completed: false }).select('_id');
            user.pendingTasks = stillAssignedPending.map(t => String(t._id));
            await user.save();

            user = await User.findById(user._id);
            return ok(res, user, 200, 'User updated');
        } catch (e) {
            if (e && e.code === 11000) return fail(res, 400, 'A user with the given email already exists');
            return fail(res, 500, 'Failed to update user');
        }
    });

    // DELETE /:id -> delete user and unassign their pending tasks
    router.delete('/:id', async function (req, res) {
        try {
            const user = await User.findById(req.params.id);
            if (!user) return fail(res, 404, 'User not found');

            // Unassign all tasks assigned to this user
            const tasks = await Task.find({ assignedUser: String(user._id) }).select('_id');
            for (const t of tasks) {
                await unassignTask(t._id);
            }

            await user.remove();
            // Per updated requirement: 204 No Content on successful delete, no response body
            return res.status(204).send();
        } catch (e) {
            return fail(res, 500, 'Failed to delete user');
        }
    });

    return router;
}
