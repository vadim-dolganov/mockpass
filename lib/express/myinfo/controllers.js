const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const bodyParser = require('body-parser')
const { pick, partition } = require('lodash')

const jose = require('node-jose')
const jwt = require('jsonwebtoken')

const assertions = require('../../assertions')
const consent = require('./consent')

const MOCKPASS_PRIVATE_KEY = fs.readFileSync(
  path.resolve(__dirname, '../../../static/certs/spcp-key.pem'),
)
const MOCKPASS_PUBLIC_KEY = fs.readFileSync(
  path.resolve(__dirname, '../../../static/certs/spcp.crt'),
)

module.exports = (version, myInfoSignature) => (
  app,
  { serviceProvider, encryptMyInfo },
) => {
  const verify = (signature, baseString) => {
    const verifier = crypto.createVerify('RSA-SHA256')
    verifier.update(baseString)
    verifier.end()
    return verifier.verify(serviceProvider.pubKey, signature, 'base64')
  }

  const encryptPersona = async (persona) => {
    const signedPersona =
      version === 'v3'
        ? jwt.sign(persona, MOCKPASS_PRIVATE_KEY, {
            algorithm: 'RS256',
          })
        : persona
    const serviceCertAsKey = await jose.JWK.asKey(serviceProvider.cert, 'pem')
    const encryptedAndSignedPersona = await jose.JWE.createEncrypt(
      { format: 'compact' },
      serviceCertAsKey,
    )
      .update(JSON.stringify(signedPersona))
      .final()
    return encryptedAndSignedPersona
  }

  const lookupPerson = (allowedAttributes) => async (req, res) => {
    const requestedAttributes = (req.query.attributes || '').split(',')

    const [attributes, disallowedAttributes] = partition(
      requestedAttributes,
      (v) => allowedAttributes.includes(v),
    )

    if (disallowedAttributes.length > 0) {
      res.status(401).send({
        code: 401,
        message: 'Disallowed',
        fields: disallowedAttributes.join(','),
      })
    } else {
      const transformPersona = encryptMyInfo
        ? encryptPersona
        : (person) => person
      const persona = assertions.myinfo[version].personas[req.params.uinfin]
      res.status(persona ? 200 : 404).send(
        persona
          ? await transformPersona(pick(persona, attributes))
          : {
              code: 404,
              message: 'UIN/FIN does not exist in MyInfo.',
              fields: '',
            },
      )
    }
  }

  const allowedAttributes = assertions.myinfo[version].attributes

  app.get(
    `/myinfo/${version}/person-basic/:uinfin/`,
    (req, res, next) => {
      // sp_esvcId and txnNo needed as query params
      const [, authHeader] = req.get('Authorization').split(' ')

      const { signature, baseString } = myInfoSignature(authHeader, req)
      if (verify(signature, baseString)) {
        next()
      } else {
        res.status(403).send({
          code: 403,
          message: 'Digital Service is invalid',
          fields: '',
        })
      }
    },
    lookupPerson(allowedAttributes.basic),
  )
  app.get(`/myinfo/${version}/person/:uinfin/`, (req, res) => {
    // TODO - verify PKI_SIGN
    const token = req.get('Authorization').split(' ').pop()
    const { sub, scope } = jwt.verify(token, MOCKPASS_PUBLIC_KEY, {
      algorithms: ['RS256'],
    })
    if (sub !== req.params.uinfin) {
      res.status(401).send({
        code: 401,
        message: 'UIN requested does not match logged in user',
        fields: '',
      })
    } else {
      lookupPerson(scope)(req, res)
    }
  })

  app.get(`/myinfo/${version}/authorise`, consent.authorizeViaOIDC)

  app.post(
    `/myinfo/${version}/token`,
    bodyParser.urlencoded({
      extended: false,
      type: 'application/x-www-form-urlencoded',
    }),
    (req, res) => {
      const tokenTemplate = consent.authorizations[req.body.code]
      if (!tokenTemplate) {
        res.status(400).send({
          code: 400,
          message: 'No such authorization given',
          fields: '',
        })
      } else {
        const token = jwt.sign(
          { ...tokenTemplate, auth_time: Date.now() },
          MOCKPASS_PRIVATE_KEY,
          { expiresIn: '1800 seconds', algorithm: 'RS256' },
        )
        res.send({
          access_token: token,
          token_type: 'Bearer',
          expires_in: 1798,
        })
      }
    },
  )

  return app
}