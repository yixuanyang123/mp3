module.exports = function (router) {
    var Task = require('../models/task');
    var User = require('../models/user');

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

    // Helpers to coerce types from form-urlencoded payloads (dbFill.py uses strings)
    function toBoolean(val, def) {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'string') {
            const v = val.trim().toLowerCase();
            if (v === 'true' || v === '1') return true;
            if (v === 'false' || v === '0') return false;
        }
        return typeof def === 'boolean' ? def : false;
    }

    function toDate(val) {
        if (val instanceof Date) return val;
        if (typeof val === 'number') return new Date(val);
        if (typeof val === 'string' && val.trim() !== '') {
            // dbFill sends deadline as milliseconds since epoch (string)
            const asNum = Number(val);
            if (!Number.isNaN(asNum) && asNum > 0) return new Date(asNum);
            const d = new Date(val);
            if (!isNaN(d.getTime())) return d;
        }
        return undefined;
    }

    async function addTaskToUserPending(task) {
        if (!task.assignedUser) return;
        const user = await User.findById(task.assignedUser);
        if (!user) return;
        // Only pending tasks should be in pendingTasks
        if (!task.completed) {
            const set = new Set((user.pendingTasks || []).map(String));
            set.add(String(task._id));
            user.pendingTasks = Array.from(set);
        } else {
            user.pendingTasks = (user.pendingTasks || []).filter(tid => String(tid) !== String(task._id));
        }
        await user.save();
    }

    async function removeTaskFromAnyUser(task) {
        if (task.assignedUser) {
            const user = await User.findById(task.assignedUser);
            if (user) {
                user.pendingTasks = (user.pendingTasks || []).filter(tid => String(tid) !== String(task._id));
                await user.save();
            }
        }
    }

    // GET / -> list tasks with query params (default limit 100)
    router.get('/', async function (req, res) {
        const where = parseJSONParam(req.query.where) || {};
        const sort = parseJSONParam(req.query.sort);
        const select = parseJSONParam(req.query.select);
        const skip = req.query.skip ? parseInt(req.query.skip, 10) : undefined;
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100; // tasks: default 100
        const count = (req.query.count === true || req.query.count === 'true');

        if ((where && where.__parseError) || (sort && sort.__parseError) || (select && select.__parseError)) {
            return fail(res, 400, 'Invalid JSON in query parameters');
        }

        try {
            if (count) {
                const c = await Task.countDocuments(where || {});
                return ok(res, c);
            }
            let q = Task.find(where || {});
            if (select) q = q.select(select);
            if (sort) q = q.sort(sort);
            if (skip !== undefined) q = q.skip(skip);
            if (limit !== undefined) q = q.limit(limit);
            const docs = await q.exec();
            return ok(res, docs);
        } catch (e) {
            return fail(res, 500, 'Failed to fetch tasks');
        }
    });

    // POST / -> create task
    router.post('/', async function (req, res) {
        try {
            let { name, description, deadline, completed, assignedUser, assignedUserName } = req.body || {};
            if (!name || !deadline) return fail(res, 400, 'Task must have name and deadline');

            // Normalize defaults
            if (typeof description !== 'string') description = '';
            completed = toBoolean(completed, false);
            if (typeof assignedUser !== 'string') assignedUser = '';

            // Coerce deadline
            const deadlineDate = toDate(deadline);
            if (!deadlineDate) return fail(res, 400, 'Invalid deadline');

            // If assignedUser provided, validate and force assignedUserName to match
            if (assignedUser) {
                const user = await User.findById(assignedUser);
                if (!user) return fail(res, 400, 'assignedUser does not reference a valid user');
                assignedUserName = user.name;
            } else {
                assignedUserName = 'unassigned';
            }

            let task = new Task({ name, description, deadline: deadlineDate, completed, assignedUser, assignedUserName });
            await task.save();

            // Maintain user's pendingTasks
            if (assignedUser) {
                await addTaskToUserPending(task);
            }

            return ok(res, task, 201, 'Task created');
        } catch (e) {
            return fail(res, 500, 'Failed to create task');
        }
    });

    // GET /:id -> task by id (with select)
    router.get('/:id', async function (req, res) {
        const select = parseJSONParam(req.query.select);
        if (select && select.__parseError) return fail(res, 400, 'Invalid JSON in select parameter');
        try {
            let q = Task.findById(req.params.id);
            if (select) q = q.select(select);
            const task = await q.exec();
            if (!task) return fail(res, 404, 'Task not found');
            return ok(res, task);
        } catch (e) {
            return fail(res, 500, 'Failed to fetch task');
        }
    });

    // PUT /:id -> replace task and maintain two-way reference
    router.put('/:id', async function (req, res) {
        try {
            let body = req.body || {};
            if (!body.name || !body.deadline) return fail(res, 400, 'Task must have name and deadline');

            let task = await Task.findById(req.params.id);
            if (!task) return fail(res, 404, 'Task not found');

            // Track previous assignment
            const prevAssignedUserId = task.assignedUser ? String(task.assignedUser) : '';

            // Validate new assignedUser
            let newAssignedUserId = typeof body.assignedUser === 'string' ? body.assignedUser : '';
            let newAssignedUserName = 'unassigned';
            if (newAssignedUserId) {
                const u = await User.findById(newAssignedUserId);
                if (!u) return fail(res, 400, 'assignedUser does not reference a valid user');
                newAssignedUserName = u.name;
            }

            // Replace fields
            task.name = body.name;
            task.description = typeof body.description === 'string' ? body.description : '';
            const putDeadline = toDate(body.deadline);
            if (!putDeadline) return fail(res, 400, 'Invalid deadline');
            task.deadline = putDeadline;
            task.completed = toBoolean(body.completed, false);
            task.assignedUser = newAssignedUserId;
            task.assignedUserName = newAssignedUserName;
            await task.save();

            // Remove from previous user's pendingTasks if changed or now completed/unassigned
            if (prevAssignedUserId && (prevAssignedUserId !== newAssignedUserId)) {
                const prevUser = await User.findById(prevAssignedUserId);
                if (prevUser) {
                    prevUser.pendingTasks = (prevUser.pendingTasks || []).filter(tid => String(tid) !== String(task._id));
                    await prevUser.save();
                }
            }

            // Maintain current user's pendingTasks depending on completion
            if (newAssignedUserId) {
                await addTaskToUserPending(task);
            } else {
                await removeTaskFromAnyUser(task);
            }

            return ok(res, task, 200, 'Task updated');
        } catch (e) {
            return fail(res, 500, 'Failed to update task');
        }
    });

    // DELETE /:id -> delete task and remove from user's pendingTasks
    router.delete('/:id', async function (req, res) {
        try {
            const task = await Task.findById(req.params.id);
            if (!task) return fail(res, 404, 'Task not found');

            await removeTaskFromAnyUser(task);
            await task.remove();
            // Per updated requirement: 204 No Content on successful delete, no response body
            return res.status(204).send();
        } catch (e) {
            return fail(res, 500, 'Failed to delete task');
        }
    });

    return router;
}
