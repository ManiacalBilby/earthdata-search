import parser from 'fast-xml-parser'

import { isEmpty } from 'lodash'

import { cmrEnv } from '../../../sharedUtils/cmrEnv'
import { generateFormDigest } from '../util/generateFormDigest'
import { getApplicationConfig } from '../../../sharedUtils/config'
import { getDbConnection } from '../util/database/getDbConnection'
import { getJwtToken } from '../util/getJwtToken'
import { getOptionDefinitions } from './getOptionDefinitions'
import { getServiceOptionDefinitions } from './getServiceOptionDefinitions'
import { getValueForTag, hasTag } from '../../../sharedUtils/tags'
import { getVariables } from './getVariables'
import { getVerifiedJwtToken } from '../util/getVerifiedJwtToken'
import { harmonyFormatMapping, ousFormatMapping } from '../../../sharedUtils/outputFormatMaps'
import { parseError } from '../../../sharedUtils/parseError'
import { supportsVariableSubsetting } from './supportsVariableSubsetting'

/**
 * Retrieve access methods for a provided collection
 * @param {Object} event Details about the HTTP request that it received
 * @param {Object} context Methods and properties that provide information about the invocation, function, and execution environment
 */
const getAccessMethods = async (event, context) => {
  // https://stackoverflow.com/questions/49347210/why-aws-lambda-keeps-timing-out-when-using-knex-js
  // eslint-disable-next-line no-param-reassign
  context.callbackWaitsForEmptyEventLoop = false

  const { defaultResponseHeaders } = getApplicationConfig()

  try {
    const { body } = event
    const { params = {} } = JSON.parse(body)
    const {
      collectionId,
      collectionProvider,
      services: associatedServices,
      tags,
      variables: associatedVariables
    } = params

    const jwtToken = getJwtToken(event)

    const { id: userId } = getVerifiedJwtToken(jwtToken)
    const { count: servicesCount } = associatedServices

    let items = []
    if (servicesCount > 0) {
      ({ items } = associatedServices)
    }

    // Fetch UMM-S records with type 'ECHO ORDERS'
    const echoOrderServices = items.filter(service => service.type === 'ECHO ORDERS')

    // Ensure that we have both a UMM-S record and a matching tag because the tag contains echo form ids that UMM-S lacks
    const hasEchoOrders = echoOrderServices.length > 0 && hasTag({ tags }, 'subset_service.echo_orders')

    // Fetch UMM-S records with type 'ESI'
    const esiServices = items.filter(service => service.type === 'ESI')

    // Ensure that we have both a UMM-S record and a matching tag because the tag contains echo form ids that UMM-S lacks
    const hasEsi = esiServices.length > 0 && hasTag({ tags }, 'subset_service.esi')

    // Fetch UMM-S records with type 'OPeNDAP'
    const opendapServices = items.filter(service => service.type === 'OPeNDAP')
    const hasOpendap = opendapServices.length > 0

    // Fetch UMM-S records with type 'Harmony'
    const harmonyServices = items.filter(service => service.type === 'Harmony')
    const hasHarmony = harmonyServices.length > 0

    const capabilitiesData = getValueForTag('collection_capabilities', tags)
    const { granule_online_access_flag: downloadable } = capabilitiesData || {}

    const accessMethods = {}

    if (downloadable) {
      accessMethods.download = {
        isValid: true,
        type: 'download'
      }
    }

    if (hasEchoOrders) {
      const echoOrderData = getValueForTag('subset_service.echo_orders', tags)
      const { option_definitions: optionDefinitions } = echoOrderData

      if (optionDefinitions) {
        // Fetch the option definitions (echo forms) from Legacy Services
        const forms = await getOptionDefinitions(
          collectionProvider,
          optionDefinitions,
          jwtToken
        )

        forms.forEach((form) => {
          const [key] = Object.keys(form)

          // Extract the correct UMM-S record from the metadata
          const ummRecord = echoOrderServices.find(
            service => service.conceptId === echoOrderData.id
          )

          if (ummRecord) {
            const { type, url } = ummRecord
            const { urlValue } = url

            accessMethods[key] = {
              type,
              url: urlValue,
              ...form[key]
            }
          }
        })
      }
    }

    if (hasEsi) {
      const esiData = getValueForTag('subset_service.esi', tags)
      const { service_option_definitions: serviceOptionDefinitions } = esiData

      if (serviceOptionDefinitions) {
        // Fetch the option definitions (echo forms) from Legacy Services
        const forms = await getServiceOptionDefinitions(
          collectionProvider,
          serviceOptionDefinitions,
          jwtToken
        )

        forms.forEach((form) => {
          const [key] = Object.keys(form)

          // Extract the correct UMM-S record from the metadata
          const ummRecord = esiServices.find(
            service => service.conceptId === esiData.id
          )

          if (ummRecord) {
            const { type, url } = ummRecord
            const { urlValue } = url

            accessMethods[key] = {
              type,
              url: urlValue,
              ...form[key]
            }
          }
        })
      }
    }

    if (hasOpendap) {
      // EDSC only supports one OPeNDAP service right now
      const [fullServiceObject] = opendapServices

      const {
        conceptId,
        longName,
        name,
        supportedReformattings,
        type
      } = fullServiceObject

      const {
        hierarchyMappings,
        keywordMappings,
        variables
      } = getVariables(associatedVariables)

      const outputFormats = []

      if (supportedReformattings) {
        supportedReformattings.forEach((reformatting) => {
          const { supportedOutputFormats } = reformatting

          // Collect all supported output formats from each mapping
          outputFormats.push(...supportedOutputFormats)
        })
      }

      // Default the selected output format to the first item in the supported list
      let [selectedOutputFormat] = outputFormats;

      ({ [selectedOutputFormat]: selectedOutputFormat } = ousFormatMapping)

      accessMethods.opendap = {
        id: conceptId,
        isValid: true,
        hierarchyMappings,
        keywordMappings,
        longName,
        name,
        selectedOutputFormat,
        supportedOutputFormats: outputFormats,
        supportsVariableSubsetting: supportsVariableSubsetting(fullServiceObject),
        type,
        variables
      }
    }

    if (hasHarmony) {
      const { keywordMappings, variables } = getVariables(associatedVariables)

      harmonyServices.forEach((serviceObject, index) => {
        const {
          conceptId,
          longName,
          name,
          serviceOptions,
          supportedOutputProjections,
          supportedReformattings,
          type,
          url
        } = serviceObject

        const { subset = {} } = serviceOptions
        const { spatialSubset = {} } = subset
        const {
          boundingBox = {},
          shapefile = {}
        } = spatialSubset

        const supportsBoundingBoxSubsetting = !isEmpty(boundingBox)
        const supportsShapefileSubsetting = !isEmpty(shapefile)

        const outputFormats = []

        if (supportedReformattings) {
          supportedReformattings.forEach((reformatting) => {
            const { supportedOutputFormats } = reformatting

            // Collect all supported output formats from each mapping
            outputFormats.push(...supportedOutputFormats)
          })
        }

        // Default the selected output format to the first item in the supported list
        let [selectedOutputFormat] = outputFormats;

        ({ [selectedOutputFormat]: selectedOutputFormat } = harmonyFormatMapping)

        const { urlValue } = url

        let outputProjections = []
        if (supportedOutputProjections) {
          outputProjections = supportedOutputProjections.filter((projection) => {
            const { projectionAuthority } = projection

            return projectionAuthority != null
          }).map((projection) => {
            const { projectionAuthority } = projection

            return projectionAuthority
          })
        }

        // Default the selected output projection to the first item in the supported list
        const [selectedOutputProjection] = outputProjections

        accessMethods[`harmony${index}`] = {
          id: conceptId,
          isValid: true,
          keywordMappings,
          longName,
          name,
          selectedOutputFormat,
          selectedOutputProjection,
          supportedOutputFormats: outputFormats,
          supportedOutputProjections: outputProjections,
          supportsBoundingBoxSubsetting,
          supportsShapefileSubsetting,
          supportsVariableSubsetting: supportsVariableSubsetting(serviceObject),
          type,
          url: urlValue,
          variables
        }
      })
    }

    // Retrive a connection to the database
    const dbConnection = await getDbConnection()

    // Retrieve the user record from the database
    const accessConfigRecord = await dbConnection('access_configurations')
      .first('access_method')
      .where({ user_id: userId, collection_id: collectionId })

    // Retrieve the savedAccessConfig for this user and collection
    const authenticatedUser = await dbConnection('users')
      .first('urs_profile')
      .where({ id: userId, environment: cmrEnv() })

    let selectedAccessMethod

    // Iterate through all the access methods
    Object.keys(accessMethods).forEach((methodName) => {
      const method = accessMethods[methodName]

      // Update the accessMethod that matches the savedAccessConfig
      if (accessConfigRecord) {
        const { access_method: savedAccessConfig } = accessConfigRecord

        if (method.type === savedAccessConfig.type) {
          if (['download'].includes(method.type)) {
            selectedAccessMethod = methodName

            return
          }

          if (method.id === savedAccessConfig.id) {
            if (['Harmony', 'OPeNDAP'].includes(method.type)) {
              selectedAccessMethod = methodName

              // Pull out values from the saved access method that would not have changed
              const {
                selectedOutputFormat,
                selectedOutputProjection,
                selectedVariables
              } = savedAccessConfig

              accessMethods[methodName] = {
                ...accessMethods[methodName],
                selectedOutputFormat,
                selectedOutputProjection,
                selectedVariables
              }

              return
            }

            if (['ESI', 'ECHO ORDERS'].includes(method.type)) {
              const { form_digest: formDigest } = savedAccessConfig
              const methodFormDigest = generateFormDigest(method.form)

              // Ensure the saved EchoForm is the same form as the current EchoForm
              if (formDigest === methodFormDigest) {
                selectedAccessMethod = methodName

                // Pull out values from the saved access method that would not have changed
                const {
                  form = '',
                  model = '',
                  rawModel = '',
                  form_digest: formDigest
                } = savedAccessConfig

                // Parse the savedAccessConfig values and if it is not valid XML, don't use it
                if (parser.validate(form) === true
                  && parser.validate(model) === true
                  && parser.validate(rawModel) === true
                ) {
                  // Only override values that the user configured
                  accessMethods[methodName] = {
                    ...accessMethods[methodName],
                    form,
                    model,
                    rawModel,
                    form_digest: formDigest
                  }
                } else {
                  console.log('There was a problem parsing the savedAccessConfig values, using the default form instead.')

                  return
                }
              }
            }
          }
        }
      }

      // Add the users email address to all forms that appear within the
      // access methods (savedAccessConfigs will overwrite these with saved values)
      if (['ESI', 'ECHO ORDERS'].includes(method.type)) {
        // Retrieve the email address of the currently authenticated user to prepopulate the form
        const { urs_profile: ursProfile } = authenticatedUser
        const { email_address: emailAddress = '' } = ursProfile

        const { form } = method

        // Only attempt to update the form if an email address exists and there is a valid form
        if (emailAddress.length > 0 && form.length > 0) {
          method.form = form.replace('<ecs:email/>', `<ecs:email>${emailAddress}</ecs:email>`)
        }
      }
    })

    // If there is only 1 access method, it should be selected
    if (Object.keys(accessMethods).length === 1) {
      [selectedAccessMethod] = Object.keys(accessMethods)
    }

    return {
      isBase64Encoded: false,
      statusCode: 200,
      headers: defaultResponseHeaders,
      body: JSON.stringify({ accessMethods, selectedAccessMethod })
    }
  } catch (e) {
    return {
      isBase64Encoded: false,
      headers: defaultResponseHeaders,
      ...parseError(e)
    }
  }
}

export default getAccessMethods
