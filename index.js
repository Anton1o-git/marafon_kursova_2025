const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const sql = require('mssql/msnodesqlv8');
const fs = require('fs');

const app = express();
const port = 3000;

const dbConfig = {
    server: 'DESKTOP-315V3JR\\IS_33_11',
    database: 'marafon_kursova',
    driver: 'msnodesqlv8',
    options: {
        trustedConnection: true
    }
};

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'form.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'about.html'));
});

app.get('/event-admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'event-admin.html'));
});

// API: Отримання подій з дистанціями
app.get('/api/events', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request().query(`
            SELECT e.EventID, e.Name AS EventName, e.Location, e.EventDate,
                c.CompetitionID, c.Name, c.Distance, c.StartFee
            FROM Event e
            LEFT JOIN Competition c ON e.EventID = c.EventID
            ORDER BY e.EventDate ASC
        `);

        const grouped = {};
        result.recordset.forEach(row => {
            if (!grouped[row.EventID]) {
                grouped[row.EventID] = {
                    name: row.EventName,
                    location: row.Location,
                    date: row.EventDate,
                    competitions: []
                };
            }
            if (row.CompetitionID) {
                grouped[row.EventID].competitions.push({
                    id: row.CompetitionID,
                    name: row.Name,
                    distance: row.Distance,
                    price: row.StartFee
                });
            }
        });

        res.json(Object.entries(grouped).map(([id, data]) => ({
            eventID: id,
            ...data
        })));
    } catch (err) {
        console.error('❌ /api/events error:', err);
        res.status(500).send('Помилка завантаження подій');
    }
});

// POST: Реєстрація учасника з автоматичним BibNumber та результатами
app.post('/add-participant', async (req, res) => {
    const {
        fullName,
        birthDate,
        gender,
        contactInfo,
        ageCategoryID,
        privilegeCategoryID,
        competitionID,
        finalFee,
        startTime,
        finishTime
    } = req.body;

    try {
        const pool = await sql.connect(dbConfig);

        // Додати учасника
        const insertParticipant = await pool.request()
            .input('FullName', sql.NVarChar, fullName)
            .input('BirthDate', sql.Date, birthDate)
            .input('Gender', sql.NVarChar, gender)
            .input('ContactInfo', sql.NVarChar, contactInfo)
            .input('AgeCategoryID', sql.Int, parseInt(ageCategoryID))
            .input('PrivilegeCategoryID', sql.Int, parseInt(privilegeCategoryID))
            .query(`
                INSERT INTO Participant (FullName, BirthDate, Gender, ContactInfo, AgeCategoryID, PrivilegeCategoryID)
                OUTPUT INSERTED.ParticipantID
                VALUES (@FullName, @BirthDate, @Gender, @ContactInfo, @AgeCategoryID, @PrivilegeCategoryID)
            `);

        const participantID = insertParticipant.recordset[0].ParticipantID;

        // Знайти EventID для Competition
        const eventQuery = await pool.request()
            .input('CompetitionID', sql.Int, competitionID)
            .query(`
                SELECT EventID FROM Competition WHERE CompetitionID = @CompetitionID
            `);

        const eventID = eventQuery.recordset[0].EventID;

        // Обчислити наступний BibNumber
        const bibQuery = await pool.request()
            .input('EventID', sql.Int, eventID)
            .query(`
                SELECT ISNULL(MAX(BibNumber), 0) + 1 AS NewBib
                FROM Registration
                WHERE CompetitionID IN (
                    SELECT CompetitionID FROM Competition WHERE EventID = @EventID
                )
            `);

        const bibNumber = bibQuery.recordset[0].NewBib;

        const netTime = (new Date(finishTime) - new Date(startTime)) / 1000; // сек

        // Реєстрація
        await pool.request()
            .input('ParticipantID', sql.Int, participantID)
            .input('CompetitionID', sql.Int, competitionID)
            .input('FinalFee', sql.Decimal(10, 2), parseFloat(finalFee))
            .input('RegistrationStatus', sql.NVarChar, 'Оплачено')
            .input('ResultStatus', sql.NVarChar, 'Фінішував')
            .input('StartTime', sql.VarChar, req.body.startTime)
            .input('FinishTime', sql.VarChar, req.body.finishTime)
            .input('BibNumber', sql.Int, bibNumber)
            .query(`
                INSERT INTO Registration (ParticipantID, CompetitionID, FinalFee, RegistrationStatus, ResultStatus, StartTime, FinishTime, BibNumber)
                VALUES (@ParticipantID, @CompetitionID, @FinalFee, @RegistrationStatus, @ResultStatus, @StartTime, @FinishTime, @BibNumber)
            `);

        const successPagePath = path.join(__dirname, 'views', 'success.html');
        let html = fs.readFileSync(successPagePath, 'utf-8');
        html = html.replace('{{BIB}}', bibNumber);

        res.send(html);
    
        } catch (err) {
            console.error('❌ Помилка при додаванні учасника:', err);
            res.status(500).send(`<pre>❌ Помилка сервера:\n${err.message}</pre>`);
        }
    }); 

    app.get('/participants', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'participants.html'));
    });

app.get('/api/participants', async (req, res) => {
    const eventID = req.query.eventID;

    try {
        const pool = await sql.connect(dbConfig);
        const request = pool.request();

        let query = `
            SELECT
                r.RegistrationID,
                p.FullName,
                p.Gender,
                p.ContactInfo,
                ac.Name AS AgeCategory,
                pc.Name AS PrivilegeCategory,
                e.Name AS EventName,
                e.EventDate,
                c.Name AS CompetitionName,
                r.BibNumber,
                r.StartTime,
                r.FinishTime,
                DATEDIFF(SECOND, r.StartTime, r.FinishTime) AS NetTimeSeconds,
                r.ResultStatus
            FROM Registration r
            JOIN Participant p ON r.ParticipantID = p.ParticipantID
            JOIN Competition c ON r.CompetitionID = c.CompetitionID
            JOIN Event e ON c.EventID = e.EventID
            JOIN AgeCategory ac ON p.AgeCategoryID = ac.AgeCategoryID
            JOIN PrivilegeCategory pc ON p.PrivilegeCategoryID = pc.PrivilegeCategoryID
            WHERE r.ResultStatus = 'Фінішував'
        `;

        if (eventID) {
            query += ' AND e.EventID = @EventID';
            request.input('EventID', sql.Int, parseInt(eventID));
        }

        query += ' ORDER BY e.EventDate DESC, c.Name, r.BibNumber';

        const result = await request.query(query);
        res.json(result.recordset);

    } catch (err) {
        console.error('❌ Помилка при завантаженні учасників:', err);
        res.status(500).send('Помилка сервера');
    }
});

// Оновлення учасника
app.put('/api/participants/:id', async (req, res) => {
    const registrationID = parseInt(req.params.id);
    const { FullName, Gender, ContactInfo, StartTime, FinishTime } = req.body;

    try {
        const pool = await sql.connect(dbConfig);

        const participantQuery = await pool.request()
            .input('RegistrationID', sql.Int, registrationID)
            .query(`
                SELECT ParticipantID FROM Registration WHERE RegistrationID = @RegistrationID
            `);

        if (participantQuery.recordset.length === 0) {
            return res.status(404).send('Не знайдено');
        }

        const participantID = participantQuery.recordset[0].ParticipantID;

        await pool.request()
            .input('ParticipantID', sql.Int, participantID)
            .input('FullName', sql.NVarChar, FullName)
            .input('Gender', sql.NVarChar, Gender)
            .input('ContactInfo', sql.NVarChar, ContactInfo)
            .query(`
                UPDATE Participant
                SET FullName = @FullName,
                    Gender = @Gender,
                    ContactInfo = @ContactInfo
                WHERE ParticipantID = @ParticipantID
            `);

        await pool.request()
            .input('RegistrationID', sql.Int, registrationID)
            .input('StartTime', sql.VarChar, StartTime)
            .input('FinishTime', sql.VarChar, FinishTime)
            .query(`
                UPDATE Registration
                SET StartTime = @StartTime,
                    FinishTime = @FinishTime
                WHERE RegistrationID = @RegistrationID
            `);

        res.sendStatus(200);
    } catch (err) {
        console.error('❌ PUT /api/participants/:id:', err);
        res.status(500).send('Помилка оновлення');
    }
});


// Видалення учасника
app.delete('/api/participants/:id', async (req, res) => {
    const registrationID = parseInt(req.params.id);

    try {
        const pool = await sql.connect(dbConfig);

        const result = await pool.request()
            .input('RegistrationID', sql.Int, registrationID)
            .query(`SELECT ParticipantID FROM Registration WHERE RegistrationID = @RegistrationID`);

        if (result.recordset.length === 0) {
            return res.status(404).send('Реєстрацію не знайдено');
        }

        const participantID = result.recordset[0].ParticipantID;

        await pool.request()
            .input('RegistrationID', sql.Int, registrationID)
            .query(`DELETE FROM Registration WHERE RegistrationID = @RegistrationID`);

        const check = await pool.request()
            .input('ParticipantID', sql.Int, participantID)
            .query(`SELECT COUNT(*) AS Count FROM Registration WHERE ParticipantID = @ParticipantID`);

        if (check.recordset[0].Count === 0) {
            await pool.request()
                .input('ParticipantID', sql.Int, participantID)
                .query(`DELETE FROM Participant WHERE ParticipantID = @ParticipantID`);
        }

        res.sendStatus(200);
    } catch (err) {
        console.error('❌ DELETE /api/participants/:id:', err);
        res.status(500).send('Помилка видалення');
    }
});
// Додати нову подію
app.post('/api/events', async (req, res) => {
    const { name, location, date } = req.body;

    try {
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('Name', sql.NVarChar, name)
            .input('Location', sql.NVarChar, location)
            .input('EventDate', sql.Date, date)
            .query(`
                INSERT INTO Event (Name, Location, EventDate)
                VALUES (@Name, @Location, @EventDate)
            `);

        res.sendStatus(201);
    } catch (err) {
        console.error('❌ POST /api/events:', err);
        res.status(500).send('Помилка при створенні події');
    }
});

// Оновити подію
app.put('/api/events/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { name, location, date } = req.body;

    try {
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('EventID', sql.Int, id)
            .input('Name', sql.NVarChar, name)
            .input('Location', sql.NVarChar, location)
            .input('EventDate', sql.Date, date)
            .query(`
                UPDATE Event
                SET Name = @Name, Location = @Location, EventDate = @EventDate
                WHERE EventID = @EventID
            `);

        res.sendStatus(200);
    } catch (err) {
        console.error('❌ PUT /api/events/:id:', err);
        res.status(500).send('Помилка при оновленні події');
    }
});

// Видалити подію
app.delete('/api/events/:id', async (req, res) => {
    const id = parseInt(req.params.id);

    try {
        const pool = await sql.connect(dbConfig);

        await pool.request()
            .input('EventID', sql.Int, id)
            .query(`DELETE FROM Competition WHERE EventID = @EventID`);

        await pool.request()
            .input('EventID', sql.Int, id)
            .query(`DELETE FROM Event WHERE EventID = @EventID`);

        res.sendStatus(200);
    } catch (err) {
        console.error('❌ DELETE /api/events/:id:', err);
        res.status(500).send('Помилка при видаленні події');
    }
});
// Додати дистанцію до події
app.post('/api/competitions', async (req, res) => {
    const { name, price, eventID, distance } = req.body;

    try {
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('Name', sql.NVarChar, name)
            .input('StartFee', sql.Decimal(10, 2), parseFloat(price))
            .input('Distance', sql.Float, parseFloat(distance))
            .input('EventID', sql.Int, parseInt(eventID))
            .query(`
                INSERT INTO Competition (Name, StartFee, Distance, EventID)
                VALUES (@Name, @StartFee, @Distance, @EventID)
            `);

        res.sendStatus(201);
    } catch (err) {
        console.error('❌ POST /api/competitions:', err);
        res.status(500).send('Помилка створення дистанції');
    }
});

// Оновити дистанцію
app.put('/api/competitions/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { name, price } = req.body;

    try {
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('CompetitionID', sql.Int, id)
            .input('Name', sql.NVarChar, name)
            .input('StartFee', sql.Decimal(10, 2), parseFloat(price))
            .query(`
                UPDATE Competition
                SET Name = @Name, StartFee = @StartFee
                WHERE CompetitionID = @CompetitionID
            `);

        res.sendStatus(200);
    } catch (err) {
        console.error('❌ PUT /api/competitions/:id:', err);
        res.status(500).send('Помилка оновлення дистанції');
    }
});
// Видалити дистанцію
app.delete('/api/competitions/:id', async (req, res) => {
    const id = parseInt(req.params.id);

    try {
        const pool = await sql.connect(dbConfig);

        const check = await pool.request()
            .input('CompetitionID', sql.Int, id)
            .query(`SELECT COUNT(*) AS Count FROM Registration WHERE CompetitionID = @CompetitionID`);

        if (check.recordset[0].Count > 0) {
            return res.status(400).send('Неможливо видалити — до цієї дистанції вже прив’язані учасники');
        }

        await pool.request()
            .input('CompetitionID', sql.Int, id)
            .query(`DELETE FROM Competition WHERE CompetitionID = @CompetitionID`);

        res.sendStatus(200);
    } catch (err) {
        console.error('❌ DELETE /api/competitions/:id:', err);
        res.status(500).send('Помилка видалення дистанції');
    }
});

// Запуск сервера
app.listen(port, () => {
    console.log(`✅ Сервер працює: http://localhost:${port}`);
});
