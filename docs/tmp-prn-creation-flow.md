## PRN creation page + data flow

```mermaid
sequenceDiagram

Actor U as User Browser
participant FE as epr-frontend
participant BE as epr-backend
participant DB as Mongo


U->>FE: GET /dashboard
FE->>U: <html>dashboard page</html>
note over U: click "create PRN" link

U->>FE: GET /create
FE->>U: <html>create page</html>
note over U: fill in form, click "submit"
U->>FE: POST /create
alt if validation errors
  FE->>U: <html>create page with errors</html>
end
FE->>BE: POST /organisation/{organisationId}/accreditation/{accreditationId}/prn<br>payload { tonnage, producerId, issuerNotes }
BE->>DB: create PRN document, status = draft
alt if backend returns error
  BE->>FE: 4XX or 5XX
  FE->>U: 500 <html>error!</html>
end
BE->>FE: 200 prnId
FE->>U: 301: /cya/{prnId}

U->>FE: GET /cya/{prnId}
FE->>BE: GET /organisation/{organisationId}/accreditation/{accreditationId}/prns/{prnId}
BE->>FE: 200 { prnData }
note over FE: check status is "draft"
alt status not draft
  FE->>U: 500 <html>error!</html>
end
FE->>U: <html>cya page</html>
note over U: click "submit"
U->>FE: POST /cya/{prnId}
FE->>BE: **POST /organisation/{organisationId}/accreditation/{accreditationId}/prns/{prnId}/submit**
BE->>DB: update PRN document, status = awaiting_authorisation
alt if backend returns error
  BE->>FE: 4XX or 5XX
  FE->>U: 500 <html>error!</html>
end
BE->>FE: 200
FE->>U: 301: /confirmation

U->>FE: GET /confirmation
FE->>BE: GET /organisation/{organisationId}/accreditation/{accreditationId}/prns/{prnId}
BE->>FE: 200 { prnData }
note over FE: check status is "awaiting_authorisation"
alt status not awaiting_authorisation
  FE->>U: 500 <html>error!</html>
end
FE->>U: <html>confirmation page</html>
```



### New APIs

#### POST /organisations/{organisationId}/accreditations/{accreditationId}/prn
body: `{ tonnage, producerId, issuerNotes }`

creates PRN document with `status: draft`
returns PRN ID
validation
 - `accreditationId` owned by `organisationId`
 - sufficient waste balance available for specified tonnage

***NOTE: delivered by PAE-926***


#### GET /organisations/{organisationId}/accreditations/{accreditationId}/prns/{prnId}

surfaces latest data for specified PRN
validation
- `accreditationId` owned by `organisationId` (prevent API access to PRNs belong to other organisations)

***NOTE: delivered by PAE-926***

####POST /organisations/{organisationId}/accreditations/{accreditationId}/prns/{prnId}/submit
body: `empty`

performs the transition from `status: draft -> awaiting_authorisation`
validation
 - `accreditationId` owned by `organisationId`
 - prn in `draft` status
 - sufficient waste balance available for specified tonnage


#### POST /organisation/{organisationId}/accreditation/{accreditationId}/prns/{prnId}/issue
body: `empty`

performs the transition from `status: awaiting_authorisation -> awaiting_acceptance`
validation
 - `accreditationId` owned by `organisationId`
 - prn in `draft` status
 - sufficient waste balance available for specified tonnage

