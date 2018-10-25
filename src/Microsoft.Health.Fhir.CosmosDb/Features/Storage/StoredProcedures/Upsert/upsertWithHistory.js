﻿/**
* This stored procedure provides the following functionality:
* - Upsert a document (when no etag provided)
* - Replaces a document (when etag is provided)
* - A history record will be created only when the resource exists
* 
* @constructor
* @param {any} doc - The CosmosResourceWrapper to save
* @param {string} matchVersionId - optional etag to match against when replacing an existing document
* @param {boolean} allowCreate - specifies if a resource can be created or only replaced
* @param {boolean} keepHistory - specifies if a resource should keep a copy of itself when updating
*/
function upsertWithHistory(doc, matchVersionId, allowCreate, keepHistory) {
    const collection = getContext().getCollection();
    const collectionLink = collection.getSelfLink();
    const response = getContext().getResponse();

    const errorCodes = { ServiceUnavailable: 503 };

    const errorMessages = {
        DocumentNull: `${ErrorCodes.BadRequest}: The document is undefined or null.`,
        InputWasArray: `${ErrorCodes.BadRequest}: Input should not be an array.`,
        RequestNotQueued: `${errorCodes.ServiceUnavailable}: Request could not be queued.`,
        DocumentNotFound: `${ErrorCodes.NotFound}: Document not found.`,
        PreconditionFailed: `${ErrorCodes.PreconditionFailed}: One of the specified pre-condition is not met.`
    };

    const initialVersion = "1";

    // Validate input
    if (!doc) {
        throw new Error(errorMessages.DocumentNull);
    }

    if (doc instanceof Array) {
        throw new Error(errorMessages.InputWasArray);
    }

    if (!stringIsNullOrEmpty(matchVersionId) || !allowCreate) {
        tryReplace(doc, replacePrimaryCallback, matchVersionId);
    } else {
        tryCreate(doc, createPrimaryCallback);
    }

    function tryCreate(doc, callback) {
        // Initial version 1
        doc.version = initialVersion;

        let isAccepted = collection.createDocument(collectionLink, doc, { disableAutomaticIdGeneration: true }, callback);

        if (!isAccepted) {
            throw new Error(errorMessages.RequestNotQueued);
        }
    }

    function stringIsNullOrEmpty(str) {
        return str === undefined || str === null || str === "";
    }

    function getHexSegment(len) {
        let segment = "";
        for (let i = 0; i < len; i++) {
            segment += Math.floor(Math.random() * 16).toString(16);
        }
        return segment;
    }

    function generateGuid() {
        return `${getHexSegment(8)}-${getHexSegment(4)}-${getHexSegment(4)}-${getHexSegment(4)}-${getHexSegment(12)}`;
    }

    /*
    * Replace performs the important function of creating a history record before the current primary record is overridden.
    */
    function tryReplace(doc, callback, matchVersionId) {
        let query = {
            query: "select * from root r where r.id = @id",
            parameters: [{ name: "@id", value: doc.id }]
        };

        let isQueryAccepted = collection.queryDocuments(
            collection.getSelfLink(),
            query,
            function (err, documents) {
                if (err) {
                    throw err;
                }

                if (documents.length === 0) {
                    throw new Error(errorMessages.DocumentNotFound);
                }

                let document = documents[0];

                let documentVersion = document.version;

                // If a match version was passed in, check it matches the primary record
                if (!stringIsNullOrEmpty(matchVersionId) && !stringIsNullOrEmpty(documentVersion)) {
                    if (documentVersion !== matchVersionId) {
                        throw new Error(errorMessages.PreconditionFailed);
                    }
                }
                
                // Increment the current version
                let nextVersion = Number(documentVersion) + 1;
                if (!isNaN(nextVersion)) {
                    doc.version = nextVersion.toString();
                }
                else {
                    // if version is non-numeric, use a guid
                    doc.version = generateGuid();
                }

                // If a document was found, copy the self link for replacing the primary record
                let selfLink = document._self;

                if (keepHistory) {
                    // Convert the currect primary record to a 'history' record
                    let historyDocument = convertToHistoryRecord(document);

                    // Insert the history object
                    let isHistoryAccepted = collection.createDocument(collectionLink, historyDocument, { disableAutomaticIdGeneration: true },
                        function (insertHistoryErr) {
                            if (insertHistoryErr) {
                                if (insertHistoryErr.number === ErrorCodes.Conflict ||
                                    insertHistoryErr.number === ErrorCodes.PreconditionFailed) {
                                    // If history record has failed to insert based on the deterministic Id, retry by re-reading the record

                                    tryReplace(doc, callback, matchVersionId);
                                    return;
                                }

                                throw insertHistoryErr;
                            }

                            // After the history record has been created the primary record can be replaced with the new values.
                            // This will use the callback passed into the parent function to continue the flow in returning from the sproc
                            let isAccepted = collection.replaceDocument(selfLink, doc, { disableAutomaticIdGeneration: true, etag: document._etag }, callback);

                            if (!isAccepted) {
                                throw new Error(errorMessages.RequestNotQueued);
                            }
                        });

                    if (!isHistoryAccepted) {
                        throw new Error(errorMessages.RequestNotQueued);
                    }
                } else {
                    // Since this is a no-version document save we just replace the old document with the new values
                    let isAccepted = collection.replaceDocument(selfLink, doc, { disableAutomaticIdGeneration: true, etag: document._etag }, callback);

                    if (!isAccepted) {
                        throw new Error(errorMessages.RequestNotQueued);
                    }
                }
            });

        if (!isQueryAccepted) {
            throw new Error(errorMessages.RequestNotQueued);
        }
    }

    function convertToHistoryRecord(theDoc) {
        // Converts to specified document to a history record

        if (!theDoc.version) {
            theDoc.version = theDoc._etag.replace(/\"/g, '');
        }

        theDoc.isHistory = true;
        theDoc.id = `${theDoc.resourceId}_${theDoc.version}`;
        
        return theDoc;
    }

    function setOutput(isNew, theDoc) {
        response.setBody({ "wrapper": theDoc, "outcomeType": isNew ? "Created" : "Updated" });
    }

    function createPrimaryCallback(err, createdDoc) {
        if (err) {
            // As per 'Upsert' behavior, try to replace the document if status code is 409
            if (err.number === ErrorCodes.Conflict) {
                tryReplace(doc, replacePrimaryCallback);
                return;
            } else {
                throw err;
            }
        }

        setOutput(true, createdDoc);
    }

    function replacePrimaryCallback(err, createdDoc) {
        if (err) {
            if (err.number === ErrorCodes.Conflict ||
                err.number === ErrorCodes.PreconditionFailed) {
                throw new Error(errorMessages.PreconditionFailed);
            } else {
                throw err;
            }
        }

        setOutput(false, createdDoc);
    }
}
